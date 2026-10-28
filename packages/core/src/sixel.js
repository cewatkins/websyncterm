/**
 * Sixel graphics decoder.
 *
 * Mirrors the behaviour of `cterm_dec.c` in SynchronetBBS/sbbs:
 *
 *  - The intro is `DCS P1 [;P2 [;P3]] q`. P1 is a *vertical replication
 *    factor* (0/1/5/6 -> 2, 2 -> 5, 3/4 -> 3, 7/8/9 -> 1, otherwise 2) and
 *    P2 selects the background behaviour (0 = opaque, non-zero = transparent).
 *  - Raster attributes (`"`) are only honoured before the first data byte;
 *    P1 overrides the vertical multiplier and P2 is a horizontal
 *    replication factor.
 *  - `#Pc` selects a colour, `#Pc;2;Pr;Pg;Pb` defines one (percentages).
 *  - `!Pn` repeats the next data character, `$` returns to the left border
 *    and `-` starts a new sixel row.
 *  - Data characters are `?`..`~`; each carries six vertical pixels with the
 *    least significant bit at the top.
 */
const BAND_HEIGHT = 6;
export class SixelDecoder {
    opts = null;
    pixels = new Int32Array(0);
    width = 0;
    height = 0;
    x = 0;
    y = 0;
    colour = 0;
    transparent = false;
    repeat = 0;
    pending = [];
    sentPixels = false;
    pixelHeight = 2;
    pixelWidth = 1;
    declaredWidth = 0;
    declaredHeight = 0;
    active = false;
    /** Begin a new sixel image. */
    reset(opts) {
        this.opts = opts;
        this.width = 0;
        this.height = 0;
        this.x = 0;
        this.y = 0;
        this.sentPixels = false;
        this.repeat = 0;
        this.pending = [];
        this.transparent = opts.p2 !== 0;
        this.pixelHeight = verticalMultiplier(opts.p1);
        this.pixelWidth = 1;
        this.declaredWidth = 0;
        this.declaredHeight = 0;
        this.colour = opts.fg;
        this.active = true;
        // The band buffer holds one sixel row at a time.
        this.band = new Int32Array(0);
        this.bandWidth = 0;
    }
    band = new Int32Array(0);
    bandWidth = 0;
    /** Feed one byte of the sixel body. */
    feed(byte) {
        if (!this.active)
            return;
        if (byte >= 0x3f && byte <= 0x7e) {
            const value = byte - 0x3f;
            const count = this.repeat > 0 ? this.repeat : 1;
            this.repeat = 0;
            for (let i = 0; i < count; i++) {
                this.drawSixel(value);
                this.x += this.pixelWidth;
                this.ensureBandWidth(this.x);
            }
            this.sentPixels = true;
            return;
        }
        switch (byte) {
            case 0x21: // '!'
                this.pending = [0x21];
                this.collectNumber(byte);
                return;
            case 0x22: // '"' raster attributes
                this.pending = [0x22];
                this.collectNumber(byte);
                return;
            case 0x23: // '#'
                this.pending = [0x23];
                this.collectNumber(byte);
                return;
            case 0x24: // '$' graphics carriage return
                this.x = 0;
                this.pending = [];
                return;
            case 0x2d: // '-' graphics new line
                this.flushBand();
                this.y += BAND_HEIGHT * this.pixelHeight;
                this.x = 0;
                this.pending = [];
                return;
            case 0x3b: // ';'
            case 0x3a: // ':'
                this.pending.push(byte);
                return;
            default:
                if (byte >= 0x30 && byte <= 0x39) {
                    this.collectNumber(byte);
                    return;
                }
                // Unknown bytes are skipped.
                return;
        }
    }
    /** Collect a numeric argument. */
    collectNumber(byte) {
        if (this.pending.length === 0)
            this.pending = [byte];
        else
            this.pending.push(byte);
        const text = String.fromCharCode(...this.pending);
        const m = /^([!#"])([0-9]*)([;:]?)([0-9]*)([;:]?)([0-9]*)([;:]?)([0-9]*)$/.exec(text);
        if (!m) {
            if (text.length > 24)
                this.pending = [];
            return;
        }
        const kind = m[1];
        const nums = [m[2], m[4], m[6], m[8]].map((s) => (s === '' ? -1 : parseInt(s, 10)));
        this.pending = [];
        switch (kind) {
            case '!':
                this.repeat = Math.max(1, Math.min(0x7fff, nums[0] < 0 ? 1 : nums[0]));
                return;
            case '"': {
                // Raster attributes: only honoured before the first data byte.
                if (this.sentPixels)
                    return;
                if (nums[0] > 0)
                    this.pixelHeight = nums[0];
                if (nums[1] > 0)
                    this.pixelWidth = nums[1];
                this.declaredWidth = nums[2] > 0 ? nums[2] : 0;
                this.declaredHeight = nums[3] > 0 ? nums[3] : 0;
                return;
            }
            case '#': {
                const p1 = nums[0] < 0 ? 0 : nums[0];
                if (nums[1] === 2) {
                    // Palette map: percentages.
                    const r = Math.min(100, Math.max(0, nums[2] < 0 ? 0 : nums[2]));
                    const g = Math.min(100, Math.max(0, nums[3] < 0 ? 0 : nums[3]));
                    const b = Math.min(100, Math.max(0, nums[4] < 0 ? 0 : nums[4]));
                    const rgb = ((r * 65535 / 100) << 16) | ((g * 65535 / 100) << 8) | (b * 65535 / 100);
                    this.opts?.palette.setDac(p1, rgb & 0xffffff);
                    this.colour = p1 + 16;
                }
                else {
                    this.colour = p1 + 16;
                }
                return;
            }
            default:
                return;
        }
    }
    ensureBandWidth(width) {
        if (width <= this.bandWidth)
            return;
        const next = new Int32Array(Math.max(width, this.bandWidth * 2, 64));
        next.set(this.band.subarray(0, this.bandWidth));
        this.band = next;
        this.bandWidth = next.length;
    }
    /** Draw one sixel (six vertical pixels) at the current position. */
    drawSixel(value) {
        this.ensureBandWidth(this.x + this.pixelWidth);
        for (let bit = 0; bit < 6; bit++) {
            if (!(value & (1 << bit)))
                continue;
            for (let dx = 0; dx < this.pixelWidth; dx++) {
                const px = this.x + dx;
                if (px >= this.band.length)
                    continue;
                this.band[px] = this.colour;
            }
        }
    }
    /** Copy the current band into the image buffer. */
    flushBand() {
        const bandHeight = BAND_HEIGHT * this.pixelHeight;
        const needed = this.y + bandHeight;
        if (this.width === 0)
            this.width = this.bandWidth;
        if (needed > this.height) {
            const grown = new Int32Array(needed * Math.max(1, this.bandWidth));
            grown.set(this.pixels.subarray(0, this.height * this.bandWidth));
            this.pixels = grown;
            this.height = needed;
        }
        for (let dy = 0; dy < bandHeight; dy++) {
            const row = this.y + dy;
            for (let dx = 0; dx < this.bandWidth; dx++) {
                const v = this.band[dx];
                const idx = row * this.bandWidth + dx;
                if (v < 0)
                    continue;
                if (v === 0 && this.transparent)
                    continue;
                this.pixels[idx] = v;
            }
        }
        // Reset the band for the next row.
        this.band.fill(-1);
    }
    /** Finish the image and return it. */
    finish() {
        if (!this.active || !this.opts)
            return null;
        this.flushBand();
        this.active = false;
        const opts = this.opts;
        if (this.bandWidth === 0 || this.height === 0)
            return null;
        const out = new Int32Array(this.bandWidth * this.height);
        for (let y = 0; y < this.height; y++) {
            for (let x = 0; x < this.bandWidth; x++) {
                out[y * this.bandWidth + x] = this.pixels[y * this.bandWidth + x];
            }
        }
        return {
            pixels: out,
            width: this.bandWidth,
            height: this.height,
            baseX: opts.scrolling ? opts.originX * 8 : 0,
            baseY: opts.scrolling ? opts.originY * 16 : 0,
            cursorX: this.x,
            cursorY: this.y + BAND_HEIGHT * this.pixelHeight,
        };
    }
}
/** Map an intro P1 value to the vertical replication factor. */
export function verticalMultiplier(p1) {
    switch (p1) {
        case 0:
        case 1:
        case 5:
        case 6:
            return 2;
        case 2:
            return 5;
        case 3:
        case 4:
            return 3;
        case 7:
        case 8:
        case 9:
            return 1;
        default:
            return 2;
    }
}
//# sourceMappingURL=sixel.js.map