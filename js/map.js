/**
 * Leaflet map rendering with sunset symbology and annotations.
 * Port of dashboard/map_renderer.py
 *
 * Uses Canvas renderer for performance (single <canvas> vs 500+ SVG paths).
 * Annotations are L.divIcon markers placed along lines.
 */

const DashboardMap = (() => {
    const TILES_URL = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png';
    const TILES_ATTR = '&copy; <a href="https://carto.com/">CARTO</a>';
    const KM_RADIUS_LAT = 10 / 111;  // 10 km in degrees latitude

    let _map = null;
    let _overviewMap = null;
    let _dataLayer = null;
    let _annotLayer = null;
    let _direction = 'both';
    let _legend = null;
    let _currentFeatures = null;
    let _annotDebounceTimer = null;
    let _annotVisible = true;

    // Zoom-adaptive annotation tiers
    const ANNOT_TIERS = [
        { maxZoom: 10, minPct: 25, minLengthDeg: 0.005, spacingDeg: 0.05,  maxMarkers: 2 },
        { maxZoom: 13, minPct: 10, minLengthDeg: 0.003, spacingDeg: 0.025, maxMarkers: 4 },
        { maxZoom: Infinity, minPct: 5, minLengthDeg: 0.002, spacingDeg: 0.012, maxMarkers: 6 },
    ];

    function _getAnnotParams(zoom) {
        for (const tier of ANNOT_TIERS) {
            if (zoom <= tier.maxZoom) return tier;
        }
        return ANNOT_TIERS[ANNOT_TIERS.length - 1];
    }

    /**
     * Merge adjacent LineString segments with the same rounded pct and direction
     * into continuous polylines for seamless rendering.
     */
    function _mergeSegments(features) {
        // Group by rounded pct + direction
        const groups = {};
        features.forEach((f, i) => {
            const pct = Math.round(f.properties.pct_trips || 0);
            const dir = f.properties._dir || 'outgoing';
            const key = `${pct}_${dir}`;
            if (!groups[key]) groups[key] = [];
            groups[key].push(i);
        });

        const merged = [];

        for (const [key, indices] of Object.entries(groups)) {
            const [pctStr, dir] = key.split('_');
            const pct = parseInt(pctStr);

            // Build start-coord → feature-index map
            const startMap = new Map();
            for (const idx of indices) {
                const coords = features[idx].geometry.coordinates;
                if (!coords || coords.length < 2) continue;
                const startKey = coords[0][0] + ',' + coords[0][1];
                startMap.set(startKey, idx);
            }

            const visited = new Set();

            for (const idx of indices) {
                if (visited.has(idx)) continue;
                const f = features[idx];
                if (!f.geometry.coordinates || f.geometry.coordinates.length < 2) continue;

                // Walk chain forward
                const mergedCoords = [...f.geometry.coordinates];
                visited.add(idx);
                let maxTrips = f.properties.trips || 0;
                let current = idx;

                while (true) {
                    const curCoords = features[current].geometry.coordinates;
                    const endPt = curCoords[curCoords.length - 1];
                    const endKey = endPt[0] + ',' + endPt[1];
                    const next = startMap.get(endKey);
                    if (next === undefined || visited.has(next)) break;
                    visited.add(next);
                    const nextCoords = features[next].geometry.coordinates;
                    // Append coords, skip first point (duplicate junction)
                    for (let i = 1; i < nextCoords.length; i++) {
                        mergedCoords.push(nextCoords[i]);
                    }
                    maxTrips = Math.max(maxTrips, features[next].properties.trips || 0);
                    current = next;
                }

                merged.push({
                    type: 'Feature',
                    geometry: { type: 'LineString', coordinates: mergedCoords },
                    properties: { pct_trips: pct, trips: maxTrips, _dir: dir },
                });
            }
        }

        return merged;
    }

    /**
     * Initialize the dashboard map with Canvas renderer.
     */
    function initMap() {
        _map = L.map('map', {
            zoomControl: true,
            renderer: L.canvas(),
            preferCanvas: true,
        });
        L.tileLayer(TILES_URL, { attribution: TILES_ATTR, maxZoom: 18 }).addTo(_map);
        _map.setView([-41.2865, 174.7762], 10);
        _addLegend();
        _map.on('zoomend', _onZoomEnd);
    }

    /**
     * Initialize the overview map.
     */
    function initOverviewMap(metadata) {
        if (_overviewMap) return;
        _overviewMap = L.map('overview-map', { zoomControl: true });
        L.tileLayer(TILES_URL, { attribution: TILES_ATTR, maxZoom: 18 }).addTo(_overviewMap);

        // Group by location_key
        const groups = {};
        metadata.forEach(e => {
            const key = e.location_key || `${e.lat}_${e.lon}`;
            if (!groups[key]) {
                groups[key] = { lat: e.lat, lon: e.lon, route: e.route, location: e.location, analyses: [] };
            }
            groups[key].analyses.push(e);
        });

        const markers = [];
        const colors = ['blue', 'red', 'green', 'purple', 'orange', 'darkred', 'cadetblue', 'darkgreen'];
        let idx = 0;

        for (const [key, group] of Object.entries(groups).sort()) {
            if (!group.lat || !group.lon) continue;

            const label = `${group.route} - ${group.location}`;
            const n = group.analyses.length;
            const color = colors[idx % colors.length];
            idx++;

            let html = `<div style="min-width:240px">`;
            html += `<h4 style="margin:0 0 6px 0;color:#333">${label}</h4>`;
            html += `<ul style="margin:0;padding-left:18px">`;
            group.analyses.sort((a, b) => a.display_name.localeCompare(b.display_name));
            group.analyses.forEach(a => {
                const short = `${a.direction || ''} ${a.day_type || ''}`.trim() || a.display_name;
                html += `<li style="margin:2px 0"><a href="#" class="overview-link" data-folder="${a.folder}" style="color:#1a73e8;text-decoration:none">${short}</a></li>`;
            });
            html += '</ul></div>';

            const marker = L.marker([group.lat, group.lon], {
                icon: L.divIcon({
                    className: '',
                    html: `<div style="background:${color};color:white;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:12px;border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.4);">${n}</div>`,
                    iconSize: [28, 28],
                    iconAnchor: [14, 14],
                }),
            });
            marker.bindPopup(html, { maxWidth: 350 });
            marker.bindTooltip(`${label} (${n} analyses)`);
            marker.addTo(_overviewMap);
            markers.push(marker);
        }

        if (markers.length > 0) {
            const group = L.featureGroup(markers);
            _overviewMap.fitBounds(group.getBounds().pad(0.1));
        }

        _overviewMap.on('popupopen', () => {
            document.querySelectorAll('.overview-link').forEach(link => {
                link.addEventListener('click', (e) => {
                    e.preventDefault();
                    const folder = e.target.dataset.folder;
                    App.navigateTo('dashboard');
                    Filters.setAnalysis(folder);
                });
            });
        });
    }

    function invalidateOverview() {
        if (_overviewMap) setTimeout(() => _overviewMap.invalidateSize(), 100);
    }

    function invalidateMap() {
        if (_map) setTimeout(() => _map.invalidateSize(), 100);
    }

    function setDirection(dir) {
        _direction = dir;
    }

    function getDirection() {
        return _direction;
    }

    /**
     * Load and render GeoJSON for the current selection.
     */
    async function loadAnalysis(folder, timePeriod, linkLat, linkLon) {
        // Clear old layers
        if (_dataLayer) { _map.removeLayer(_dataLayer); _dataLayer = null; }
        if (_annotLayer) { _map.removeLayer(_annotLayer); _annotLayer = null; }
        _currentFeatures = null;

        const dirs = (_direction === 'both') ? ['outgoing', 'incoming'] : [_direction];
        const allFeatures = [];

        for (const dir of dirs) {
            const url = `data/${dir}/${folder}/${timePeriod}.geojson`;
            try {
                const resp = await fetch(url);
                if (!resp.ok) continue;
                const geojson = await resp.json();
                geojson.features.forEach(f => { f.properties._dir = dir; });
                allFeatures.push(...geojson.features);
            } catch (e) {
                console.warn(`Failed to load ${url}:`, e);
            }
        }

        if (allFeatures.length === 0) return;

        // Sort features by pct_trips ascending (larger values on top)
        allFeatures.sort((a, b) =>
            (a.properties.pct_trips || 0) - (b.properties.pct_trips || 0)
        );

        // Merge adjacent segments with same rounded pct for seamless rendering
        const mergedFeatures = _mergeSegments(allFeatures);
        mergedFeatures.sort((a, b) =>
            (a.properties.pct_trips || 0) - (b.properties.pct_trips || 0)
        );
        const mergedCollection = { type: 'FeatureCollection', features: mergedFeatures };

        // Data layer — Canvas rendered (uses merged features)
        _dataLayer = L.geoJSON(mergedCollection, {
            style: feature => {
                const pct = Math.round(feature.properties.pct_trips || 0);
                return {
                    color: Symbology.getSunsetColor(pct),
                    weight: Symbology.getLineWeight(pct),
                    opacity: 0.85,
                };
            },
            onEachFeature: (feature, layer) => {
                const pct = feature.properties.pct_trips;
                if (pct != null) {
                    layer.bindTooltip(`${Math.round(pct)}%`, { sticky: true });
                }
            },
        }).addTo(_map);

        // Annotation markers
        _currentFeatures = allFeatures;
        _annotLayer = L.layerGroup().addTo(_map);
        _refreshAnnotations();

        // Update max trips stat
        const maxTrips = allFeatures.reduce((max, f) => Math.max(max, f.properties.trips || 0), 0);
        const statEl = document.getElementById('stat-trips-value');
        if (statEl) statEl.textContent = maxTrips.toLocaleString();

        // Fit bounds: 10 km around link center
        _map.invalidateSize();
        if (linkLat != null && linkLon != null) {
            const kmRadLon = 10 / (111 * Math.cos(linkLat * Math.PI / 180));
            _map.fitBounds([
                [linkLat - KM_RADIUS_LAT, linkLon - kmRadLon],
                [linkLat + KM_RADIUS_LAT, linkLon + kmRadLon],
            ]);
        } else if (_dataLayer.getBounds().isValid()) {
            _map.fitBounds(_dataLayer.getBounds());
        }
    }

    /**
     * Re-render annotations for the current zoom level.
     */
    function _refreshAnnotations() {
        if (!_annotLayer || !_currentFeatures || _currentFeatures.length === 0) return;
        _annotLayer.clearLayers();
        if (!_annotVisible) return;
        const params = _getAnnotParams(_map.getZoom());
        _addAnnotationMarkers(_currentFeatures, params);
    }

    /**
     * Show or hide annotation markers.
     */
    function setAnnotationsVisible(visible) {
        _annotVisible = visible;
        if (_annotLayer) {
            if (visible) {
                _refreshAnnotations();
            } else {
                _annotLayer.clearLayers();
            }
        }
    }

    /**
     * Debounced zoomend handler — refreshes annotations after zoom settles.
     */
    function _onZoomEnd() {
        if (_annotDebounceTimer) clearTimeout(_annotDebounceTimer);
        _annotDebounceTimer = setTimeout(() => {
            _annotDebounceTimer = null;
            _refreshAnnotations();
        }, 150);
    }

    /**
     * Place annotation markers (arrow + percentage) along lines.
     *
     * Groups features by rounded pct to avoid duplicate labels on
     * adjacent segments of the same route, then places markers at
     * intervals along each line.
     */
    function _addAnnotationMarkers(features, params) {
        // Collect annotatable lines grouped by rounded pct
        const groups = {};  // pctInt → [{coords, dir}, ...]
        features.forEach(f => {
            const pct = f.properties.pct_trips || 0;
            if (pct < params.minPct) return;

            const geom = f.geometry;
            if (!geom) return;

            let coords;
            if (geom.type === 'LineString') {
                coords = geom.coordinates;
            } else if (geom.type === 'MultiLineString') {
                // Pick longest sub-line
                coords = geom.coordinates.reduce((a, b) => a.length >= b.length ? a : b);
            } else {
                return;
            }

            if (coords.length < 2) return;

            // Line length in degrees (approximate)
            let length = 0;
            for (let i = 1; i < coords.length; i++) {
                const dx = coords[i][0] - coords[i-1][0];
                const dy = coords[i][1] - coords[i-1][1];
                length += Math.sqrt(dx*dx + dy*dy);
            }
            if (length < params.minLengthDeg) return;

            const pctInt = Math.round(pct);
            if (!groups[pctInt]) groups[pctInt] = [];
            groups[pctInt].push({
                coords,
                dir: f.properties._dir || 'outgoing',
                length,
            });
        });

        // For each group, place markers with minimum spacing
        const placed = [];  // [{lat, lon}] for de-duplication

        // Process groups highest-pct first so important annotations get priority
        const sortedGroups = Object.entries(groups).sort((a, b) => parseInt(b[0]) - parseInt(a[0]));

        for (const [pctStr, lines] of sortedGroups) {
            const pctInt = parseInt(pctStr);

            // Sort lines by length descending — annotate longer lines first
            lines.sort((a, b) => b.length - a.length);

            for (const { coords, dir } of lines) {
                // Determine arrow character based on flow direction
                const firstLon = coords[0][0];
                const lastLon = coords[coords.length - 1][0];
                const isIncoming = dir === 'incoming';
                let arrow;
                if (firstLon > lastLon) {
                    arrow = isIncoming ? '\u203A' : '\u2039';
                } else {
                    arrow = isIncoming ? '\u2039' : '\u203A';
                }

                // Place markers at intervals along the line
                const labelText = `${arrow} ${pctInt}%`;
                _placeMarkersAlongLine(coords, labelText, placed, params.spacingDeg, params.maxMarkers);
            }
        }
    }

    /**
     * Place annotation markers at intervals along a coordinate array.
     */
    function _placeMarkersAlongLine(coords, text, placed, spacingDeg, maxMarkers) {
        // Calculate cumulative distances
        const cumDist = [0];
        for (let i = 1; i < coords.length; i++) {
            const dx = coords[i][0] - coords[i-1][0];
            const dy = coords[i][1] - coords[i-1][1];
            cumDist.push(cumDist[i-1] + Math.sqrt(dx*dx + dy*dy));
        }
        const totalLength = cumDist[cumDist.length - 1];

        // Place first marker at 30% of line length, then every spacingDeg
        let nextDist = totalLength * 0.3;
        let count = 0;

        while (nextDist < totalLength * 0.9 && count < maxMarkers) {
            // Interpolate position at nextDist
            const pos = _interpolateAt(coords, cumDist, nextDist);
            if (!pos) break;

            // Check minimum spacing against already-placed markers
            const tooClose = placed.some(p => {
                const dx = p.lon - pos[0];
                const dy = p.lat - pos[1];
                return Math.sqrt(dx*dx + dy*dy) < spacingDeg;
            });

            if (!tooClose) {
                // Calculate rotation angle from the line segment direction
                const angle = _getAngleAt(coords, cumDist, nextDist);

                const icon = L.divIcon({
                    className: 'annot-label-wrapper',
                    html: `<div class="annot-label" style="transform:rotate(${angle}deg)">${text}</div>`,
                    iconSize: [120, 30],
                    iconAnchor: [60, 15],
                });

                L.marker([pos[1], pos[0]], {
                    icon,
                    interactive: false,
                    keyboard: false,
                }).addTo(_annotLayer);

                placed.push({ lat: pos[1], lon: pos[0] });
                count++;
            }

            nextDist += spacingDeg;
        }
    }

    /**
     * Interpolate a position along a coordinate array at a given distance.
     * Returns [lon, lat] or null.
     */
    function _interpolateAt(coords, cumDist, targetDist) {
        for (let i = 1; i < coords.length; i++) {
            if (cumDist[i] >= targetDist) {
                const segLen = cumDist[i] - cumDist[i-1];
                if (segLen === 0) return coords[i];
                const t = (targetDist - cumDist[i-1]) / segLen;
                return [
                    coords[i-1][0] + t * (coords[i][0] - coords[i-1][0]),
                    coords[i-1][1] + t * (coords[i][1] - coords[i-1][1]),
                ];
            }
        }
        return null;
    }

    /**
     * Get the angle (in degrees) of the line at a given distance.
     * Returns angle suitable for CSS rotate (0 = horizontal right).
     */
    function _getAngleAt(coords, cumDist, targetDist) {
        for (let i = 1; i < coords.length; i++) {
            if (cumDist[i] >= targetDist) {
                // Use Leaflet's projection to get pixel-accurate angle
                const p1 = _map.latLngToContainerPoint([coords[i-1][1], coords[i-1][0]]);
                const p2 = _map.latLngToContainerPoint([coords[i][1], coords[i][0]]);
                const dx = p2.x - p1.x;
                const dy = p2.y - p1.y;
                let angleDeg = Math.atan2(dy, dx) * (180 / Math.PI);
                // Keep text readable (flip if upside down)
                if (angleDeg > 90) angleDeg -= 180;
                if (angleDeg < -90) angleDeg += 180;
                return Math.round(angleDeg);
            }
        }
        return 0;
    }

    /**
     * Add colour gradient legend to the map.
     */
    function _addLegend() {
        _legend = L.control({ position: 'topleft' });
        _legend.onAdd = function () {
            const div = L.DomUtil.create('div', 'map-legend');
            div.innerHTML = `<div style="background:rgba(255,255,255,0.92);padding:12px 18px;border-radius:8px;box-shadow:0 1px 5px rgba(0,0,0,0.25);font-size:14px;">
                <div style="font-weight:600;margin-bottom:6px;color:#333;">% of Max Trips</div>
                <div style="height:18px;width:270px;border-radius:5px;background:${Symbology.getLegendGradient()};"></div>
                <div style="display:flex;justify-content:space-between;margin-top:4px;color:#555;font-size:12px;">
                    <span>0%</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span>
                </div>
            </div>`;
            return div;
        };
        _legend.addTo(_map);
    }

    return {
        initMap, initOverviewMap, invalidateOverview, invalidateMap,
        setDirection, getDirection, loadAnalysis, setAnnotationsVisible,
    };
})();
