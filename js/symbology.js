/**
 * Symbology — sunset color gradient and line weight.
 * Port of dashboard/symbology.py
 */

const Symbology = (() => {
    // Plasma colour stops: [pct, R, G, B]
    const COLOR_STOPS = [
        [0,   0xFC, 0xFD, 0xBF],
        [10,  0xFE, 0xE9, 0x9A],
        [20,  0xFE, 0xD2, 0x7C],
        [30,  0xFE, 0xB8, 0x66],
        [40,  0xFE, 0x9B, 0x5A],
        [50,  0xF9, 0x7E, 0x56],
        [60,  0xED, 0x64, 0x58],
        [70,  0xDA, 0x4C, 0x5E],
        [80,  0xC0, 0x3A, 0x65],
        [90,  0x9C, 0x2E, 0x7F],
        [100, 0x3B, 0x0F, 0x70],
    ];

    const LINE_WEIGHT_MIN = 1;
    const LINE_WEIGHT_MAX = 14;

    function _hex(n) {
        return n.toString(16).padStart(2, '0');
    }

    /**
     * Get plasma-gradient color for a percentage value (0–100).
     * @param {number} pct
     * @returns {string} Hex color string e.g. '#fe9b5a'
     */
    function getSunsetColor(pct) {
        if (pct == null || isNaN(pct)) return '#fcfdbf';
        pct = Math.max(0, Math.min(100, pct));

        for (let i = 0; i < COLOR_STOPS.length - 1; i++) {
            const [p0, r0, g0, b0] = COLOR_STOPS[i];
            const [p1, r1, g1, b1] = COLOR_STOPS[i + 1];
            if (pct <= p1) {
                const t = (p1 !== p0) ? (pct - p0) / (p1 - p0) : 0;
                const r = Math.round(r0 + (r1 - r0) * t);
                const g = Math.round(g0 + (g1 - g0) * t);
                const b = Math.round(b0 + (b1 - b0) * t);
                return `#${_hex(r)}${_hex(g)}${_hex(b)}`;
            }
        }
        return '#3b0f70';
    }

    /**
     * Get line weight based on percentage (0–100).
     * @param {number} pct
     * @returns {number} Line weight in pixels.
     */
    function getLineWeight(pct) {
        if (pct == null || isNaN(pct)) return LINE_WEIGHT_MIN;
        pct = Math.max(0, Math.min(100, pct));
        return LINE_WEIGHT_MIN + (pct / 100) * (LINE_WEIGHT_MAX - LINE_WEIGHT_MIN);
    }

    /**
     * Build CSS gradient string for the legend.
     * @returns {string} CSS linear-gradient value.
     */
    function getLegendGradient() {
        const stops = COLOR_STOPS.map(
            ([p, r, g, b]) => `#${_hex(r)}${_hex(g)}${_hex(b)} ${p}%`
        );
        return `linear-gradient(to right, ${stops.join(', ')})`;
    }

    return { getSunsetColor, getLineWeight, getLegendGradient };
})();
