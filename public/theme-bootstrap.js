(() => {
  const defaults = { version: 3, theme: "router", accent: null, density: "comfortable", motion: "system", glow: 50, inflightPlacement: "left" };
  let saved = defaults;
  try {
    const key = "routetok-dashboard-preferences";
    const parsed = JSON.parse(localStorage.getItem(key) || localStorage.getItem("agentrouter-dashboard-preferences") || "null");
    if (parsed && [1, 2, 3, 4, 5].includes(parsed.version)) saved = { ...defaults, ...parsed };
  } catch (_) {}
  try {
    const oneOf = (value, values, fallback) => values.includes(value) ? value : fallback;
    const theme = oneOf(saved.theme, ["system", "router", "abyss", "ultraviolet", "ember", "paper"], defaults.theme);
    const density = oneOf(saved.density, ["compact", "comfortable", "spacious"], defaults.density);
    const motion = oneOf(saved.motion, ["system", "full", "reduced"], defaults.motion);
    const glow = typeof saved.glow === "number" && Number.isFinite(saved.glow) ? Math.min(100, Math.max(0, saved.glow)) : defaults.glow;
    const accent = typeof saved.accent === "string" && /^#[0-9a-f]{6}$/i.test(saved.accent) ? saved.accent.toLowerCase() : null;
    const media = (query) => typeof matchMedia === "function" && matchMedia(query).matches;
    const root = document.documentElement;
    root.dataset.themeSetting = theme;
    root.dataset.theme = theme === "system" ? (media("(prefers-color-scheme: light)") ? "paper" : "router") : theme;
    root.dataset.density = density;
    root.dataset.motionSetting = motion;
    root.dataset.motion = motion === "system" ? (media("(prefers-reduced-motion: reduce)") ? "reduced" : "full") : motion;
    const placement = ["left", "right", "main"].includes(saved.inflightPlacement)
      ? saved.inflightPlacement
      : saved.railSide === "right" ? "right" : "left";
    root.dataset.railSide = placement === "right" ? "right" : "left";
    root.dataset.inflightPlacement = placement;
    root.dataset.accent = accent ? "custom" : "theme";
    root.style.setProperty("--glow-multiplier", String(glow / 50));
    root.style.colorScheme = root.dataset.theme === "paper" ? "light" : "dark";
    if (accent) {
      const rgb = [1, 3, 5].map((offset) => parseInt(accent.slice(offset, offset + 2), 16)).join(", ");
      root.style.setProperty("--acid", accent);
      root.style.setProperty("--acid-rgb", rgb);
    }
  } catch (_) {}
})();
