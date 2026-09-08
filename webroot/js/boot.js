/*
 * FoxyTail WebUI - boot: theme, bridge probe, initial route.
 * Loaded last, after every page has registered itself with the router.
 */
(function () {
  'use strict';

  var FOXY = window.FOXY;

  FOXY.router.loadTheme();
  FOXY.initBridge();
  if (!location.hash) location.hash = '#/dashboard';
  FOXY.router.render();
})();
