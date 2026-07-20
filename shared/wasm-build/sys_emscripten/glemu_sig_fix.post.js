// idTech3-web: under MAIN_MODULE, libdylink addFunction()s every JS library
// function into the wasm table and requires a .sig. LEGACY_GL_EMULATION's
// setupHooks() replaces these with closures that lack it. Runs post-script-eval,
// before wasm instantiation resolves the GOT.
(function () {
  var sigs = {
    glActiveTexture: 'vi', glEnable: 'vi', glDisable: 'vi', glGetIntegerv: 'vii',
    glTexEnvi: 'viii', glTexEnvf: 'viif', glTexEnvfv: 'viii',
    glGetTexEnviv: 'viii', glGetTexEnvfv: 'viii',
  };
  for (var n in sigs) {
    try {
      var fn = eval('_' + n);          // module-scope var
      if (typeof fn === 'function' && !fn.sig) fn.sig = sigs[n];
    } catch (e) {}
  }
  // glemu aborts with "TODO" on these; they are meaningless/no-ops against the
  // WebGL default framebuffer (idTech3 calls glDrawBuffer(GL_BACK) per frame).
  function noopGL(mode) {}
  noopGL.sig = 'vi';
  try { _glDrawBuffer = noopGL; } catch (e) {}
  try { _glReadBuffer = noopGL; } catch (e) {}
  // the wasm import object captured the aborting originals by value — rebind
  try { wasmImports['glDrawBuffer'] = noopGL; wasmImports['glReadBuffer'] = noopGL; } catch (e) {}
})();
