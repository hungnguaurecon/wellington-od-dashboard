/**
 * Cascading filter logic.
 * Port of _filter_metadata / _unique_sorted from 2_Analysis_Dashboard.py
 */

const Filters = (() => {
    let _metadata = [];  // array of metadata entries
    let _manifest = {};  // folder → [time_periods]
    let _onChangeCallback = null;

    // Filter chain order — each narrows the next
    const FILTER_CHAIN = [
        { id: 'f-route',        field: 'route' },
        { id: 'f-location',     field: 'location' },
        { id: 'f-direction',    field: 'direction' },
        { id: 'f-day_type',     field: 'day_type' },
        { id: 'f-vehicle_type', field: 'vehicle_type' },
        { id: 'f-period',       field: 'period' },
    ];

    /**
     * Initialize filters with metadata and manifest data.
     */
    async function init(onChange) {
        _onChangeCallback = onChange;

        const [metaResp, manResp] = await Promise.all([
            fetch('data/metadata.json'),
            fetch('data/manifest.json'),
        ]);
        _metadata = await metaResp.json();
        _manifest = await manResp.json();

        // Wire up change events
        FILTER_CHAIN.forEach(({ id }) => {
            document.getElementById(id).addEventListener('change', _onFilterChange);
        });
        document.getElementById('f-time-period').addEventListener('change', _notifyChange);

        // Populate initial values
        _rebuildFrom(0);
    }

    /**
     * Filter metadata entries by criteria object.
     */
    function _filterEntries(entries, criteria) {
        return entries.filter(e => {
            for (const [field, value] of Object.entries(criteria)) {
                if (value != null && e[field] !== value) return false;
            }
            return true;
        });
    }

    /**
     * Extract unique sorted values for a field.
     */
    function _uniqueSorted(entries, field) {
        const vals = new Set();
        entries.forEach(e => { if (e[field]) vals.add(e[field]); });
        return [...vals].sort();
    }

    /**
     * Populate a <select> with options, preserving previous selection if possible.
     */
    function _populateSelect(id, values) {
        const el = document.getElementById(id);
        const prev = el.value;
        el.innerHTML = '';
        values.forEach(v => {
            const opt = document.createElement('option');
            opt.value = v;
            opt.textContent = v;
            el.appendChild(opt);
        });
        // Restore previous selection if still available
        if (values.includes(prev)) {
            el.value = prev;
        }
    }

    /**
     * Rebuild filters starting from a given index in the chain.
     */
    function _rebuildFrom(startIndex) {
        // Build criteria from all filters before startIndex
        let filtered = _metadata;
        const criteria = {};

        for (let i = 0; i < FILTER_CHAIN.length; i++) {
            const { id, field } = FILTER_CHAIN[i];

            if (i >= startIndex) {
                // Rebuild this dropdown
                const options = _uniqueSorted(filtered, field);
                _populateSelect(id, options);
            }

            // Apply this filter's current value for subsequent dropdowns
            const val = document.getElementById(id).value;
            if (val) {
                criteria[field] = val;
                filtered = _filterEntries(_metadata, criteria);
            }
        }

        // Rebuild time periods for the resolved analysis
        _rebuildTimePeriods();
        _notifyChange();
    }

    /**
     * Rebuild the time period dropdown based on resolved analysis.
     */
    function _rebuildTimePeriods() {
        const resolved = getResolvedAnalysis();
        if (!resolved) {
            _populateSelect('f-time-period', []);
            return;
        }

        const direction = DashboardMap ? DashboardMap.getDirection() : 'outgoing';
        const lookupDir = (direction === 'both') ? 'outgoing' : direction;
        const key = `${lookupDir}/${resolved.folder}`;
        const periods = _manifest[key] || [];

        const display = periods.map(tp => {
            const parts = tp.split('-');
            if (parts.length === 2 && parts[0].length === 4 && parts[1].length === 4) {
                return `${parts[0].slice(0,2)}:${parts[0].slice(2)} - ${parts[1].slice(0,2)}:${parts[1].slice(2)}`;
            }
            return tp;
        });

        const select = document.getElementById('f-time-period');
        const prev = select.value;
        select.innerHTML = '';
        periods.forEach((raw, i) => {
            const opt = document.createElement('option');
            opt.value = raw;
            opt.textContent = display[i];
            select.appendChild(opt);
        });
        if (periods.includes(prev)) {
            select.value = prev;
        }
    }

    function _onFilterChange(e) {
        // Find which filter changed and rebuild from the next one
        const changedId = e.target.id;
        const idx = FILTER_CHAIN.findIndex(f => f.id === changedId);
        if (idx >= 0) {
            _rebuildFrom(idx + 1);
        }
    }

    function _notifyChange() {
        if (_onChangeCallback) _onChangeCallback();
    }

    /**
     * Get the currently resolved analysis metadata entry.
     * @returns {object|null}
     */
    function getResolvedAnalysis() {
        const criteria = {};
        FILTER_CHAIN.forEach(({ id, field }) => {
            const val = document.getElementById(id).value;
            if (val) criteria[field] = val;
        });

        const matched = _filterEntries(_metadata, criteria);
        return matched.length > 0 ? matched[0] : null;
    }

    /**
     * Get the currently selected raw time period string.
     * @returns {string}
     */
    function getTimePeriod() {
        return document.getElementById('f-time-period').value;
    }

    /**
     * Rebuild time periods (called when direction changes).
     */
    function refreshTimePeriods() {
        _rebuildTimePeriods();
        _notifyChange();
    }

    /**
     * Navigate to a specific analysis by setting filter values.
     */
    function setAnalysis(folder) {
        const entry = _metadata.find(e => e.folder === folder);
        if (!entry) return;
        FILTER_CHAIN.forEach(({ id, field }) => {
            const el = document.getElementById(id);
            el.value = entry[field];
        });
        _rebuildFrom(0);
    }

    return { init, getResolvedAnalysis, getTimePeriod, refreshTimePeriods, setAnalysis };
})();
