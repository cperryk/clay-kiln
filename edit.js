'use strict'; // eslint-disable-line

var references = require('./services/references'),
  path = require('path'),
  behaviors = require('./services/forms/behaviors'),
  decorators = require('./services/components/decorators'),
  dom = require('@nymag/dom'),
  EditorToolbar = require('./controllers/kiln-toolbar-edit'),
  render = require('./services/components/render'),
  keyCode = require('keycode'),
  select = require('./services/components/select'),
  form = require('./services/forms'),
  progress = require('./services/progress'),
  Konami = require('konami-js'),
  takeOffEveryZig = require('./services/pane/move-zig'),
  plugins = require('./services/plugins'),
  eventify = require('eventify'),
  link = require('./services/deep-link'),
  connectionLostMessage = 'Connection Lost. Changes will <strong>NOT</strong> be saved.',
  behaviorReq = require.context('./behaviors', false, /^\.\/[\w\-]+\.js$/), // no *.test.js
  decoratorReq = require.context('./decorators', false, /^\.\/[\w\-]+\.js$/); // no *.test.js

// show progress indicator as well as "Loading" message
progress.start('offline');

// Require all scss/css files needed
require.context('./styleguide', true, /^.*\.(scss|css)$/);
require.context('./behaviors', true, /^.*\.(scss|css)$/);

// add behaviors and decorators
behaviorReq.keys().forEach(function (key) {
  behaviors.add(path.basename(key, '.js'), behaviorReq(key));
});

decoratorReq.keys().forEach(function (key) {
  decorators.add(decoratorReq(key));
});

// kick off controller loading when DOM is ready
// note: external behaviors, decorators, and validation rules should already be added
// when this event fires
document.addEventListener('DOMContentLoaded', function () {
  window.kiln = window.kiln || {}; // make sure global kiln object exists
  window.kiln.services = window.kiln.services || {};
  eventify.enable(window.kiln); // enable events on global kiln object, so plugins can add listeners
  plugins.init(); // initialize plugins before adding handlers
  return render.addComponentsHandlers(document).then(function () {
    // if you're opening a page with a deep link in the hash,
    // go directly to the specified form.
    // note: this should happen after handlers are added (including placeholders)
    if (window.location.hash) {
      link.navigate();
    }

    return new EditorToolbar(dom.find('[' + references.referenceAttribute + '*="/components/clay-kiln"]'));
  });
});

/**
 * determine if a browser supports the (hover) media query, in any form
 * @returns {boolean}
 */
function hasHoverMediaQuery() {
  const HOVER_NONE = '(hover: none),(-moz-hover: none),(-ms-hover: none),(-webkit-hover: none)',
    HOVER_ON_DEMAND = '(hover: on-demand),(-moz-hover: on-demand),(-ms-hover: on-demand),(-webkit-hover: on-demand)',
    HOVER_HOVER = '(hover: hover),(-moz-hover: hover),(-ms-hover: hover),(-webkit-hover: hover)';

  return window.matchMedia(`${HOVER_NONE},${HOVER_ON_DEMAND},${HOVER_HOVER}`).matches;
}

// handle connection loss and hoverability
window.addEventListener('load', function () {
  if (!hasHoverMediaQuery()) {
    // firefox (and older browsers) doesn't currently support the hover media query,
    // so we want to default to simply using old :hover
    // rather than dynamically checking the capabilities of the browser
    document.body.classList.add('kiln-default-hover');
  }

  // test connection loss on page load
  if (!navigator.onLine) {
    // we're offline!
    progress.open('offline', connectionLostMessage, null, true);
  }
});

window.addEventListener('online', function () {
  progress.close(); // in case there are any status messages open, close them
});

window.addEventListener('offline', function () {
  progress.done('offline'); // turn any progress indicators to grey and end them
  progress.open('offline', connectionLostMessage, null, true);
});

new Konami(takeOffEveryZig);

// navigate components when hitting ↑ / ↓ arrows (if there's a component selected)
document.addEventListener('keydown', function (e) {
  const current = select.getCurrentSelected();

  if (current && !form.hasOpenForm()) {
    let key = keyCode(e);

    if (key === 'up') {
      e.preventDefault();
      return select.navigateComponents(current, 'prev')(e);
    } else if (key === 'down') {
      e.preventDefault();
      return select.navigateComponents(current, 'next')(e);
    }
  }
});
