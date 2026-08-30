// ExportManager.js
//
// Composites the photograph and the overlay into a NEW canvas at the
// photograph's own resolution. The source image is only ever read from, so the
// original is untouched no matter how many times you export.
//
// A caption strip is appended below the picture carrying the calibration the
// drawing was made with, plus the accuracy caveat, so an exported image cannot
// be mistaken for a survey.

export class ExportManager {
  constructor(renderer) {
    this.renderer = renderer;
  }

  /**
   * @returns {HTMLCanvasElement}
   */
  compose(scene, { image, caption = true, maxEdge = 4096 } = {}) {
    const iw = scene.imageWidth;
    const ih = scene.imageHeight;

    // Very large photographs are downscaled so the export cannot blow up
    // memory on an iPad, but the overlay is drawn at the same scale so nothing
    // shifts relative to the picture.
    const fit = Math.min(1, maxEdge / Math.max(iw, ih));
    const w = Math.round(iw * fit);
    const h = Math.round(ih * fit);

    const u = w / 1000;
    const lineHeight = 26 * u;
    const pad = 20 * u;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    // Wrap the caption before sizing the canvas, so a long line can never run
    // off the edge of the exported picture.
    const lines = caption
      ? this._wrapCaption(ctx, this._captionLines(scene), w - pad * 2, u)
      : [];
    const stripHeight = lines.length ? pad * 2 + lineHeight * lines.length : 0;

    canvas.width = w;
    canvas.height = h + Math.round(stripHeight);

    ctx.fillStyle = '#0b1016';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.scale(fit, fit);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, 0, 0, iw, ih);
    this.renderer.draw(ctx, scene);
    ctx.restore();

    if (lines.length) this._caption(ctx, lines, { x: 0, y: h, w, u, pad, lineHeight });
    return canvas;
  }

  _captionLines(scene) {
    const { model, solution, options, originDistance } = scene;
    const n = (v) => model.formatNumber(v);
    return [
      `PERSPECTIVE ELEVATION RULER — line-of-sight measurement plane only`,
      `Origin ${model.formatElevation(model.originElevation)} · Point B ${model.formatElevation(
        model.knownElevation,
      )} · Horizontal distance ${n(model.horizontalDistance)}${model.unitSuffix} · Grade ${model.formatGrade()}`,
      `Increment ${n(model.increment)}${model.unitSuffix} · Range ±${n(model.range)}${
        model.unitSuffix
      } · Camera height ${n(solution.cameraHeight)}${model.unitSuffix} · Origin distance ${n(
        originDistance,
      )}${model.unitSuffix} · FOV ${Math.round(options.fovDeg)}°`,
      `Visual estimate, not a survey. Elevations are valid along the line of sight shown, not across the whole photograph.`,
    ];
  }

  /** Font for a caption line, given which of the original rows it came from. */
  _captionFont(u, row) {
    return `${row === 0 ? '700' : '400'} ${(row === 0 ? 17 : 15) * u}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
  }

  /** Greedy word wrap, keeping each fragment tagged with its source row. */
  _wrapCaption(ctx, rows, maxWidth, u) {
    const out = [];
    rows.forEach((text, row) => {
      ctx.font = this._captionFont(u, row);
      const words = text.split(' ');
      let line = '';
      for (const word of words) {
        const next = line ? `${line} ${word}` : word;
        if (line && ctx.measureText(next).width > maxWidth) {
          out.push({ text: line, row });
          line = word;
        } else {
          line = next;
        }
      }
      if (line) out.push({ text: line, row });
    });
    return out;
  }

  _caption(ctx, lines, { x, y, w, u, pad, lineHeight }) {
    ctx.save();
    ctx.fillStyle = '#0b1016';
    ctx.fillRect(x, y, w, pad * 2 + lineHeight * lines.length);
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = Math.max(1, u);
    ctx.beginPath();
    ctx.moveTo(x, y + 0.5);
    ctx.lineTo(x + w, y + 0.5);
    ctx.stroke();

    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const lastRow = lines.length ? lines[lines.length - 1].row : 0;
    lines.forEach(({ text, row }, i) => {
      ctx.font = this._captionFont(u, row);
      ctx.fillStyle =
        row === 0 ? '#8fe9ff' : row === lastRow ? 'rgba(255,255,255,0.62)' : 'rgba(255,255,255,0.86)';
      ctx.fillText(text, x + pad, y + pad + lineHeight * (i + 0.5));
    });
    ctx.restore();
  }

  toBlob(canvas, type = 'image/png', quality = 0.94) {
    return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  }

  /**
   * Hand the finished image to the user. On iPadOS the share sheet is the only
   * route that reaches "Save Image", so try that first and fall back to a
   * download link (and finally to opening the image in a new tab).
   */
  async deliver(canvas, filename = 'elevation-ruler.png') {
    const blob = await this.toBlob(canvas);
    if (!blob) throw new Error('Could not encode the image.');

    const file = new File([blob], filename, { type: 'image/png' });
    if (navigator.canShare?.({ files: [file] }) && navigator.share) {
      try {
        await navigator.share({ files: [file], title: 'Perspective Elevation Ruler' });
        return 'shared';
      } catch (err) {
        if (err?.name === 'AbortError') return 'cancelled';
        // fall through to download
      }
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return 'downloaded';
  }
}
