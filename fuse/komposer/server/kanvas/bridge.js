// SPDX-License-Identifier: Apache-2.0
// Kanvas's bridge: loaded by every built design in its sandboxed frame. It
// outlines the element under the pointer, reports a click as a selection with
// the element's source location (data-kanvas-src, added by the build), and
// draws the numbered pins Kanvas sends it. It talks to Kanvas only through
// postMessage; the frame's origin is opaque, so messages go to "*" and
// Kanvas checks that a message comes from a frame it created.
//
// Hold Alt to use the design normally (clicks pass through, no outline, the
// wheel scrolls it). Otherwise the wheel and Space go to Kanvas's canvas,
// which zooms and pans, and the frame reports the design's height so Kanvas
// can show it whole.
//
// Prototype: plain script, fixed overlay colours inside the design's frame.

(function () {
  "use strict";
  var ACCENT = "#0a86d8";
  var PIN = { open: "#d98a0b", addressed: "#1ba673", resolved: "#7b8794" };
  var send = function (message) {
    window.parent.postMessage(message, "*");
  };

  var style = document.createElement("style");
  style.textContent =
    ".kanvas-overlay{position:absolute;pointer-events:none;z-index:2147483646;box-sizing:border-box}" +
    ".kanvas-hover{outline:2px dashed " + ACCENT + ";outline-offset:1px}" +
    ".kanvas-selected{outline:2px solid " + ACCENT + ";outline-offset:1px;background:rgba(10,134,216,.08)}" +
    ".kanvas-pin{position:absolute;z-index:2147483647;min-width:22px;height:22px;padding:0 6px;border-radius:11px 11px 11px 2px;" +
    "color:#fff;font:600 12px/22px system-ui,sans-serif;text-align:center;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.35);border:0}";
  document.head.appendChild(style);

  var hoverBox = null;
  var selectedBox = null;
  var pins = [];
  var shown = { pins: [], selected: null };

  var anchorOf = function (el) {
    while (el && el.nodeType === 1 && !el.hasAttribute("data-kanvas-src")) el = el.parentElement;
    return el && el.nodeType === 1 ? el : null;
  };

  var selectorOf = function (el) {
    var parts = [];
    while (el && el.nodeType === 1 && el !== document.body) {
      var part = el.tagName.toLowerCase();
      var parent = el.parentElement;
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function (c) {
          return c.tagName === el.tagName;
        });
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(el) + 1) + ")";
      }
      parts.unshift(part);
      el = parent;
    }
    return parts.length ? "body > " + parts.join(" > ") : "body";
  };

  var findEl = function (src, selector) {
    var bySelector = null;
    try {
      bySelector = document.querySelector(selector);
    } catch (e) {
      bySelector = null;
    }
    if (bySelector && bySelector.getAttribute("data-kanvas-src") === src) return bySelector;
    var all = document.querySelectorAll('[data-kanvas-src="' + src.replace(/"/g, '\\"') + '"]');
    if (all.length) return all[0];
    return bySelector;
  };

  var place = function (box, el) {
    var r = el.getBoundingClientRect();
    box.style.left = r.left + window.scrollX + "px";
    box.style.top = r.top + window.scrollY + "px";
    box.style.width = r.width + "px";
    box.style.height = r.height + "px";
  };

  var box = function (cls) {
    var b = document.createElement("div");
    b.className = "kanvas-overlay " + cls;
    document.body.appendChild(b);
    return b;
  };

  var draw = function () {
    pins.forEach(function (p) {
      p.remove();
    });
    pins = [];
    if (selectedBox) selectedBox.remove();
    selectedBox = null;
    if (shown.selected) {
      var sel = findEl(shown.selected.src, shown.selected.selector);
      if (sel) {
        selectedBox = box("kanvas-selected");
        place(selectedBox, sel);
      }
    }
    var used = {};
    shown.pins.forEach(function (pin) {
      var el = findEl(pin.src, pin.selector);
      if (!el) return;
      var r = el.getBoundingClientRect();
      var key = Math.round(r.left) + ":" + Math.round(r.top);
      var offset = (used[key] || 0) * 26;
      used[key] = (used[key] || 0) + 1;
      var b = document.createElement("button");
      b.type = "button";
      b.className = "kanvas-pin";
      b.textContent = String(pin.n);
      b.setAttribute("aria-label", "Comment " + pin.n);
      b.style.background = PIN[pin.state] || PIN.open;
      b.style.left = Math.max(0, r.right + window.scrollX - 12 + offset) + "px";
      b.style.top = Math.max(0, r.top + window.scrollY - 12) + "px";
      b.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        send({ type: "kanvas:pin", id: pin.id });
      });
      document.body.appendChild(b);
      pins.push(b);
    });
  };

  document.addEventListener(
    "mousemove",
    function (event) {
      var el = event.altKey ? null : anchorOf(event.target);
      if (!el || (event.target && event.target.classList && event.target.classList.contains("kanvas-pin"))) {
        if (hoverBox) hoverBox.style.display = "none";
        return;
      }
      if (!hoverBox) hoverBox = box("kanvas-hover");
      hoverBox.style.display = "block";
      place(hoverBox, el);
    },
    true,
  );

  document.addEventListener(
    "click",
    function (event) {
      if (event.altKey) return;
      if (event.target && event.target.classList && event.target.classList.contains("kanvas-pin")) return;
      var el = anchorOf(event.target);
      event.preventDefault();
      event.stopPropagation();
      if (!el) return;
      var parts = el.getAttribute("data-kanvas-src").split(":");
      var column = Number(parts.pop());
      var line = Number(parts.pop());
      var text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120);
      send({
        type: "kanvas:select",
        anchor: { file: parts.join(":"), line: line, column: column, tag: el.tagName.toLowerCase(), selector: selectorOf(el), text: text },
      });
    },
    true,
  );

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.type !== "kanvas:show") return;
    shown = { pins: Array.isArray(data.pins) ? data.pins : [], selected: data.selected || null };
    draw();
  });

  document.addEventListener(
    "wheel",
    function (event) {
      if (event.altKey) return;
      event.preventDefault();
      send({ type: "kanvas:wheel", x: event.clientX, y: event.clientY, dy: event.deltaY, mode: event.deltaMode });
    },
    { capture: true, passive: false },
  );

  var typing = function (el) {
    return el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  };
  var space = function (event) {
    if (event.key !== " " || event.altKey || typing(event.target)) return;
    event.preventDefault();
    if (!event.repeat) send({ type: "kanvas:space", down: event.type === "keydown" });
  };
  document.addEventListener("keydown", space, true);
  document.addEventListener("keyup", space, true);

  // The design's height. It never drops below the frame's own height, so a
  // design shorter than the frame keeps it, and one that fills the viewport
  // stays as it is.
  var lastHeight = 0;
  var reportSize = function () {
    var h = Math.ceil(Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0));
    if (Math.abs(h - lastHeight) <= 2) return;
    lastHeight = h;
    send({ type: "kanvas:size", height: h });
  };
  if (window.ResizeObserver) new ResizeObserver(reportSize).observe(document.documentElement);

  window.addEventListener("resize", draw);
  var ready = function () {
    send({ type: "kanvas:ready" });
    reportSize();
    setTimeout(reportSize, 300);
    // Layout can settle after fonts load.
    setTimeout(draw, 200);
  };
  if (document.readyState === "complete") ready();
  else window.addEventListener("load", ready);
})();
