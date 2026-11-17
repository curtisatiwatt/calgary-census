/**
 * Own one tooltip for the whole map. Leaflet's per-layer bindTooltip queues
 * mouseovers during a drag until moveend; departed layers can then all reopen.
 * Fresh hover/focus events are the only way to open this shared overlay.
 *
 * `area` (optional) returns the viewport rectangle the tooltip should stay in;
 * a tooltip that would leave it above its anchor is placed beside or below it.
 */
export function createMapTooltip({ map, tooltip, enabled = () => true, hoverEnabled = () => true, area = null }) {
  const container = map.getContainer();
  const document = container.ownerDocument;
  const window = document.defaultView;
  const bindings = new Set();
  let active = null;
  let moving = false;
  let zooming = false;
  let destroyed = false;

  function clearDescription() {
    if (!active) return;
    const { element, descriptionId } = active;
    if (element && descriptionId) {
      const ids = (element.getAttribute('aria-describedby') || '')
        .split(/\s+/)
        .filter(id => id && id !== descriptionId);
      if (ids.length) element.setAttribute('aria-describedby', ids.join(' '));
      else element.removeAttribute('aria-describedby');
    }
    active = null;
  }

  function close() {
    clearDescription();
    tooltip.close();
  }

  function show(binding, event, keyboard = false) {
    const original = event?.originalEvent;
    if (
      destroyed ||
      moving ||
      zooming ||
      !enabled() ||
      !map.hasLayer(binding.layer) ||
      (!keyboard &&
        (!hoverEnabled() ||
          original?.pointerType === 'touch' ||
          original?.sourceCapabilities?.firesTouchEvents ||
          original?.buttons > 0))
    )
      return;
    const latlng = binding.anchor(event);
    if (!latlng) return;
    if (active?.binding !== binding) {
      clearDescription();
      tooltip.setContent(binding.content);
    }
    // The binding's offset is how far the tooltip sits from its anchor; it normally opens above.
    const reach = Math.max(Math.abs(binding.offset[0]), Math.abs(binding.offset[1]));
    const place = direction => {
      tooltip.options.direction = direction;
      tooltip.options.offset = { top: [0, -reach], bottom: [0, reach], right: [reach, 0], left: [-reach, 0] }[
        direction
      ];
    };
    place('top');
    tooltip.setLatLng(latlng).openOn(map);
    const box = area && tooltip.getElement()?.getBoundingClientRect?.();
    if (box) {
      const room = area();
      const direction =
        box.left < room.left ? 'right' : box.right > room.right ? 'left' : box.top < room.top ? 'bottom' : null;
      if (direction) {
        place(direction);
        tooltip.setLatLng(latlng);
      }
    }
    const element = binding.layer.getElement?.();
    const descriptionId = tooltip.getElement()?.id;
    active = { binding, element, descriptionId };
    if (element && descriptionId) {
      const ids = new Set((element.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
      ids.add(descriptionId);
      element.setAttribute('aria-describedby', [...ids].join(' '));
    }
  }

  function bind(layer, { content, anchor, offset = [0, -10] }) {
    const binding = { layer, content, anchor, offset };
    bindings.add(binding);
    let element;
    const focus = () => {
      if (element?.matches(':focus-visible')) show(binding, undefined, true);
    };
    const leave = () => {
      if (active?.binding === binding) close();
    };
    const hover = event => show(binding, event);
    const detachFocus = () => {
      element?.removeEventListener('focus', focus);
      element?.removeEventListener('blur', leave);
      element = null;
    };
    const attachFocus = () => {
      detachFocus();
      element = layer.getElement?.();
      element?.addEventListener('focus', focus);
      element?.addEventListener('blur', leave);
    };
    const handlers = { mouseover: hover, mousemove: hover, mouseout: leave, add: attachFocus, remove: unbind };
    function unbind() {
      leave();
      detachFocus();
      layer.off(handlers);
      bindings.delete(binding);
    }
    binding.unbind = unbind;
    layer.on(handlers);
    attachFocus();
    return unbind;
  }

  const startMove = () => {
    moving = true;
    close();
  };
  const endMove = () => {
    moving = false;
  };
  const startZoom = () => {
    zooming = true;
    close();
  };
  const endZoom = () => {
    zooming = false;
  };
  const keydown = event => {
    if (event.key === 'Escape') close();
  };
  const visibility = () => {
    if (document.hidden) close();
  };
  const mapEvents = {
    movestart: startMove,
    moveend: endMove,
    zoomstart: startZoom,
    zoomend: endZoom,
    preclick: close,
    unload: destroy,
  };

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    close();
    for (const binding of [...bindings]) binding.unbind();
    map.off(mapEvents);
    tooltip.off('remove', clearDescription);
    container.removeEventListener('mouseleave', close);
    window.removeEventListener('blur', close);
    window.removeEventListener('resize', close);
    document.removeEventListener('keydown', keydown);
    document.removeEventListener('visibilitychange', visibility);
  }

  map.on(mapEvents);
  tooltip.on('remove', clearDescription);
  container.addEventListener('mouseleave', close);
  window.addEventListener('blur', close);
  window.addEventListener('resize', close);
  document.addEventListener('keydown', keydown);
  document.addEventListener('visibilitychange', visibility);
  return { bind, close, destroy, isMoving: () => moving || zooming };
}
