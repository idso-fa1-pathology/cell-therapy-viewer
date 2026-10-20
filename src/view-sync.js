// Follow the active viewer's current image coordinates on each rendered frame.
// Only the active viewer animates; immediate follower updates cannot feed back.
export class ViewSync {
  constructor(viewers) {
    this.viewers = viewers;
    this.enabled = true;
    this.active = 'he';
    this.applying = false;
    this.cleanup = [];
    for (const [key, viewer] of Object.entries(viewers)) {
      const activate = () => { if (!this.applying) this.active = key; };
      const draw = () => {
        if (this.active === key) this.align();
      };
      for (const event of ['pan', 'zoom']) {
        viewer.addHandler(event, activate);
        this.cleanup.push(() => viewer.removeHandler(event, activate));
      }
      viewer.addHandler('update-viewport', draw);
      this.cleanup.push(() => viewer.removeHandler('update-viewport', draw));
      // Taking over during an animation must immediately select the new driver,
      // including wheel, pointer, touch, and keyboard navigation.
      for (const event of ['pointerdown', 'wheel', 'keydown']) {
        viewer.element.addEventListener(event, activate, { capture: true, passive: true });
        this.cleanup.push(() => viewer.element.removeEventListener(event, activate, true));
      }
    }
    this.align();
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (enabled) this.align();
  }

  align() {
    if (!this.enabled || this.applying) return;
    const source = this.viewers[this.active];
    const target = this.viewers[this.active === 'he' ? 'ihc' : 'he'];
    const sourceImage = source.world.getItemAt(0);
    const targetImage = target.world.getItemAt(0);
    if (!sourceImage || !targetImage) return;
    const sourceCenter = source.viewport.getCenter(true);
    const imageCenter = sourceImage.viewportToImageCoordinates(sourceCenter.x, sourceCenter.y, true);
    const center = targetImage.imageToViewportCoordinates(imageCenter.x, imageCenter.y, true);
    const imageZoom = sourceImage.viewportToImageZoom(source.viewport.getZoom(true));
    const zoom = targetImage.imageToViewportZoom(imageZoom);
    const current = target.viewport.getCenter(true);
    const targetCenter = target.viewport.getCenter(false);
    // Also stop any old independent animation when the user re-enables sync.
    const sameCenter = point => Math.abs(point.x - center.x) < 1e-12 && Math.abs(point.y - center.y) < 1e-12;
    if (sameCenter(current) && sameCenter(targetCenter)
      && Math.abs(target.viewport.getZoom(true) - zoom) < 1e-12
      && Math.abs(target.viewport.getZoom(false) - zoom) < 1e-12) return;
    this.applying = true;
    try {
      target.viewport.zoomTo(zoom, null, true);
      target.viewport.panTo(center, true);
    } finally {
      this.applying = false;
    }
  }

  destroy() {
    for (const remove of this.cleanup) remove();
    this.cleanup = [];
  }
}
