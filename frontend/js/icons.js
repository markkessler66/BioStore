// Monochrome icons. One family, used as inline SVG.
const Icons = (() => {
  const svg = (paths) =>
    `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

  const paths = {
    folder: svg('<path d="M3 7.5h6l2 2H21v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 19z"/><path d="M3 7.5V5.5A1.5 1.5 0 0 1 4.5 4H9l2 2"/>'),
    network: svg('<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="6" r="1.6"/><circle cx="12" cy="18" r="1.6"/><circle cx="19" cy="8" r="1.6"/><circle cx="19" cy="16" r="1.6"/><path d="M6.5 11.2 10.5 7M6.5 12.8 10.5 17M13.5 7.2 17.4 8M13.5 16.8 17.4 16"/>'),
    align: svg('<path d="M4 7h16M4 12h16M4 17h10"/>'),
    file: svg('<path d="M14 3H7.5A1.5 1.5 0 0 0 6 4.5v15A1.5 1.5 0 0 0 7.5 21h9a1.5 1.5 0 0 0 1.5-1.5V8z"/><path d="M14 3v5h5"/>'),
    search: svg('<circle cx="11" cy="11" r="6"/><path d="m20 20-3.5-3.5"/>'),
    sidebar: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>'),
    more: svg('<circle cx="6" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="18" cy="12" r="1"/>'),
    close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
    refresh: svg('<path d="M20 12a8 8 0 1 1-2.2-5.5"/><path d="M20 4v5h-5"/>'),
    sun: svg('<circle cx="12" cy="12" r="3.5"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4"/>'),
    moon: svg('<path d="M16 3.5A8.5 8.5 0 1 0 20.5 14 7 7 0 0 1 16 3.5z"/>'),
    jobs: svg('<path d="M8 6h12M8 12h12M8 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>'),
    play: svg('<path d="M8 5.5v13l11-6.5z"/>'),
    lock: svg('<rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
    chevron: svg('<path d="m9 6 6 6-6 6"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    upload: svg('<path d="M12 16V5"/><path d="m7 9 5-5 5 5"/><path d="M5 19h14"/>'),
  };

  function el(name) {
    const span = document.createElement("span");
    span.className = "ico";
    span.innerHTML = paths[name] || paths.file;
    return span;
  }

  return { el, paths };
})();
