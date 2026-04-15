/**
 * Main app — page routing, event wiring, initialization.
 */

const App = (() => {
    let _metadata = null;

    /** Format ISO date "2025-03-01" → "1 Mar 2025" */
    function _formatDate(iso) {
        const d = new Date(iso + 'T00:00:00');
        const months = ['Jan','Feb','Mar','Apr','May','Jun',
                        'Jul','Aug','Sep','Oct','Nov','Dec'];
        return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
    }

    /**
     * Navigate to a page view.
     */
    function navigateTo(page) {
        // Update nav buttons
        document.querySelectorAll('.nav-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.page === page);
        });

        // Show/hide page views
        document.querySelectorAll('.page-view').forEach(view => {
            view.classList.toggle('active', view.id === `page-${page}`);
        });

        // Invalidate map sizes after page switch and reload data
        if (page === 'overview') {
            // Lazy-init overview map on first visit (container must be visible)
            if (_metadata && _metadata.length > 0) {
                DashboardMap.initOverviewMap(_metadata);
            }
            DashboardMap.invalidateOverview();
        } else if (page === 'dashboard') {
            DashboardMap.invalidateMap();
            // Re-trigger analysis load so fitBounds works on the now-visible map
            setTimeout(_onSelectionChange, 150);
        }
    }

    /**
     * Handle filter or time period change — reload the map.
     */
    function _onSelectionChange() {
        const meta = Filters.getResolvedAnalysis();
        const tp = Filters.getTimePeriod();
        if (!meta || !tp) return;

        DashboardMap.loadAnalysis(meta.folder, tp, meta.lat, meta.lon);

        // Update trips count from API metadata (authoritative)
        const tripsEl = document.getElementById('stat-trips-value');
        if (tripsEl && meta.api_trips_counted) {
            tripsEl.textContent = meta.api_trips_counted.toLocaleString();
        }

        // Update period in stat box
        const periodEl = document.getElementById('stat-period');
        if (periodEl) {
            if (meta.date_start && meta.date_end) {
                periodEl.textContent = `${_formatDate(meta.date_start)} – ${_formatDate(meta.date_end)}`;
            } else {
                periodEl.textContent = meta.period || '—';
            }
        }
    }

    /**
     * Wire up direction toggle buttons.
     */
    function _initDirectionToggle() {
        document.querySelectorAll('#direction-toggle .seg-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('#direction-toggle .seg-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                DashboardMap.setDirection(btn.dataset.dir);
                Filters.refreshTimePeriods();
            });
        });
    }

    /**
     * Wire up annotation toggle buttons.
     */
    function _initAnnotationToggle() {
        document.querySelectorAll('#annot-toggle .seg-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('#annot-toggle .seg-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                DashboardMap.setAnnotationsVisible(btn.dataset.annot === 'on');
            });
        });
    }

    /**
     * Initialize the application.
     */
    async function init() {
        // Nav routing
        document.querySelectorAll('.nav-btn').forEach(btn => {
            btn.addEventListener('click', () => navigateTo(btn.dataset.page));
        });

        // Init dashboard map
        DashboardMap.initMap();

        // Direction toggle
        _initDirectionToggle();

        // Annotation toggle
        _initAnnotationToggle();

        // Load metadata for overview
        try {
            const resp = await fetch('data/metadata.json');
            _metadata = await resp.json();
        } catch (e) {
            console.warn('Could not load metadata:', e);
            _metadata = [];
        }

        // Init filters — this triggers the first map load via _onSelectionChange
        await Filters.init(_onSelectionChange);
    }

    // Auto-init on DOM ready
    document.addEventListener('DOMContentLoaded', init);

    return { navigateTo };
})();
