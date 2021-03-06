import _ from 'lodash';

var select = require('selection-range'),
  MediumEditor = require('medium-editor'),
  MediumButton = require('@yoshokatana/medium-button'),
  MediumEditorPhrase = require('medium-editor-phrase'),
  safeAttribute = require('../services/field-helpers/safe-attribute'),
  dom = require('@nymag/dom'),
  db = require('../services/edit/db'),
  render = require('../services/components/render'),
  focus = require('../decorators/focus'),
  references = require('../services/references'),
  edit = require('../services/edit'),
  model = require('text-model'),
  site = require('../services/site'),
  progress = require('../services/progress'),
  refAttr = references.referenceAttribute;

// pass config actions to text-model
model.updateSameAs({
  // all headings (inside the current component) should be converted to bold text
  H1: 'STRONG',
  H2: 'STRONG',
  H3: 'STRONG',
  H4: 'STRONG',
  H5: 'STRONG',
  H6: 'STRONG'
});

/**
 * whan that sellection, with his ranges soote
 * the finalle node hath perced to the roote
 * @param {Node} node
 */
function selectAfter(node) {
  var range = document.createRange(),
    selection = window.getSelection();

  if (node && node.nodeType === 1) {
    range.setStartAfter(node); // set the caret after this node
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    // Of the DOM, to inputte's end they wende
    // the hooly blisful caret for to seke
    // that hem hath holpen, when that they were pasted
  }
}

/**
 * split innerHTML into paragraphs based on closing <p>/<div> and line breaks
 * trim the resulting strings to get rid of any extraneous whitespace
 * @param {string} str
 * @returns {array}
 */
function splitParagraphs(str) {
  // </p>, </div>, </h1> through </h9>, or two (interchangeable) <br> or newlines
  // note: <br> tags may contain closing slashes, and there may be spaces around stuff
  // note: split on both </blockquote> and <blockquote>, since there may be text before/after the quote
  let paragraphs = _.map(str.split(/(?:<\/(?:p|div|h[1-9])>|(?:\s?<br(?:\s?\/)?>\s?|\s?\n\s?){2})/ig), s => s.trim());

  // splitting on the closing p/div/header allows us to grab ALL the paragraphs from
  // google docs, since when you paste from there the last paragraph
  // isn't wrapped in a <p> tag. weird, right?
  // splitting on closing <div> tags allows us to support some weird
  // google docs situations (lots of line breaks with embedded media),
  // as well as "plaintext" editors like IA Writer
  // splitting on double line breaks/<br> tags allows us to catch a few edge cases in other editors

  // handle inline blockquotes (and, in the future, other inline things)
  // that should be parsed out as separate components
  return _.reduce(paragraphs, function (result, graf) {
    if (_.includes(graf, '<blockquote') || _.includes(graf, '</blockquote')) {
      let start = graf.indexOf('<blockquote'),
        end = graf.indexOf('</blockquote>') + 13, // length of that closing tag
        before = graf.substring(0, start),
        quote = graf.substring(start, end),
        after = graf.substring(end);

      result.push(before);
      result.push(quote); // pass this through so it gets picked up by rules
      result.push(after);
    } else {
      result.push(graf);
    }
    return result;
  }, []);
}

/**
 * match components from strings of random pasted input
 * note: paragraphs (and other components with rules that specify sanitization)
 * will have their values returned as text models instead of strings
 * @param  {array} strings
 * @param {array} rules chain of responsibility for paste rules
 * @param {Element} el needs to be cleared if it throws an error
 * @returns {array}
 */
function matchComponents(strings, rules, el) {
  return _.filter(_.map(strings, function (str) {
    let cleanStr, matchedRule, matchedObj, matchedValue;

    // remove extraneous opening <p>, <div>, and <br> tags
    // note: some google docs pastes might have `<p><br>`
    cleanStr = str.replace(/^\s?<(?:p><br|p|div|br)(?:.*?)>\s?/ig, '');
    // remove any other <p> or <div> tags, because you cannot put block-level tags inside paragraphs
    cleanStr = cleanStr.replace(/<(?:p|div).*?>/ig, '');
    // remove 'line separator' and 'paragraph separator' characters
    // (not visible in text editors, but get added when pasting from pdfs and old systems)
    cleanStr = cleanStr.replace(/(\u2028|\u2029)/g, '');
    // convert tab characters to spaces (pdfs looooove tab characters)
    cleanStr = cleanStr.replace(/(?:\t|\\t)/g, ' ');
    // convert nonbreaking spaces to regular spaces
    cleanStr = cleanStr.replace(/&nbsp;/ig, ' ');
    // assume newlines that AREN'T between a period and a capital letter (or number) are errors
    // note: this fixes issues when pasting from pdfs or other sources that automatically
    // insert newlines at arbitrary places
    cleanStr = cleanStr.replace(/\.\n[A-Z0-9]/g, '<br>');
    cleanStr = cleanStr.replace(/\n/g, ' ');
    // FINALLY, trim the string to catch any of the stuff we converted to spaces above
    cleanStr = cleanStr.trim();

    matchedRule = _.find(rules, function matchRule(rule) {
      return rule.match.exec(cleanStr);
    });

    if (!matchedRule) {
      // remove pasted content from element and display an error
      dom.clearChildren(el);
      progress.open('error', `Error pasting text: No rule found for "${_.truncate(cleanStr, { length: 40, omission: '…' })}"`);
      throw new Error('No matching paste rule for ' + cleanStr);
    }

    // grab stuff from matched rule, incl. component, field, sanitize
    matchedObj = _.assign({}, matchedRule);

    // find actual matched value for component
    // note: rules need to grab _some value_ from the string
    matchedValue = matchedRule.match.exec(cleanStr)[1];

    if (matchedRule.sanitize) {
      // if a rule says the value needs sanitization, pass it through text-model
      matchedValue = model.fromElement(dom.create(matchedValue));
    }

    // finally, add the potentially-sanitized value into the matched obj
    matchedObj.value = matchedValue;

    return matchedObj;
  }), function filterMatches(component) {
    var val = component.value;

    // filter out any components that are blank (filled with empty spaces)
    // this happens a lot when paragraphs really only contain <p> tags, <div>s, or extra spaces
    // we filter AFTER generating text models because the generation gets rid of tags that paragraphs can't handle

    // return true if the string contains words (anything that isn't whitespace, but not just a single closing tag),
    // or if it's a text-model that contains words (anything that isn't whitespace, but not just a single closing tag)
    return _.isString(val) && val.match(/\S/) && !val.match(/^<\/.*?>$/) || _.isString(val.text) && val.text.match(/\S/) && !val.text.match(/^<\/.*?>$/);
  });
}

/**
 * toggle the tiered toolbar
 * this is the action for the tieredToolbar extension
 * @param {Element} html
 * @returns {Element}
 */
function toggleTieredToolbar(html) {
  // note: this element doesn't exist before it's instantiated, so we need to grab it afterwards
  var toolbar = dom.find('.medium-editor-toolbar'),
    toolbarClasses = toolbar.classList;

  if (toolbarClasses.contains('show-none')) {
    toolbarClasses.remove('show-none');
  } else if (toolbarClasses.contains('show-all')) {
    toolbarClasses.add('show-none');
  } else {
    toolbarClasses.add('show-all');
  }
  return html;
}

/**
 * create new medium editor
 * @param {Element} field
 * @param {Array} buttonsWithOptions  array containing strings and objects
 * @returns {object}
 */
function createEditor(field, buttonsWithOptions) {
  var extensions = {
      tieredToolbar: new MediumButton({
        label: '&hellip;',
        action: toggleTieredToolbar
      })
    },
    buttons = buttonsWithOptions.map(button => {
      let type, settings;

      if (_.isObject(button)) { // button is an object with settings
        type = Object.keys(button)[0];
        settings = button[type];
        if (type === 'phrase') {
          extensions[settings.name] = new MediumEditorPhrase(settings); // add button to extensions
        }
        return settings.name;
      }
      return button; // button is a string
    });

  // add "remove formatting" button to the end
  buttons.push('removeFormat');

  return new MediumEditor(field, {
    toolbar: {
      // buttons that go in the toolbar
      buttons: buttons,
      standardizeSelectionStart: true,
      allowMultiParagraphSelection: false
    },
    delay: 200, // wait a bit for the toolbar and link previews to display
    paste: {
      forcePlainText: false,
      cleanPastedHTML: true, // clean html from sources like google docs
      cleanTags: [ // remove these tags when pasting
        'meta',
        'script',
        'style',
        'object',
        'iframe',
        'table'
      ],
      preCleanReplacements: [
        [/&lt;(.*?)&gt;/ig, '<$1>'], // catch any html trying to be sent in as escaped strings,
        // thus allowing cleanTags (above) or text-model to manage them
        [/<h[1-9]>/ig, '<h2>'],
        [/<\/h[1-9]>/ig, '</h2>'], // force all headers to the same level
        // decode SPECIFIC html entities (not all of them, as that's a security hole)
        ['&amp;', '&'],
        ['&nbsp;', ' '],
        ['&ldquo;', '“'],
        ['&rdguo;', '”'],
        ['&lsquo;', '‘'],
        ['&rsquo;', '’'],
        ['&hellip;', '…'],
        ['&mdash;', '—'],
        ['&ndash;', '–']
      ]
    },
    anchor: {
      linkValidation: true // check for common protocols on links
    },
    autoLink: false, // create links automatically when urls are entered
    imageDragging: false, // disallow dragging inline images
    targetBlank: true,
    disableReturn: true,
    placeholder: false, // the placeholder isn't native
    extensions: extensions
  });
}

/**
 * get elements and data for the current component
 * @param {Element} el
 * @returns {object}
 */
function getCurrent(el) {
  var currentComponent = dom.closest(el, '[' + refAttr + ']'),
    currentComponentRef = currentComponent.getAttribute(refAttr);

  return {
    field: el.getAttribute(references.fieldAttribute),
    component: currentComponent,
    ref: currentComponentRef,
    name: references.getComponentNameFromReference(currentComponentRef)
  };
}

/**
 * get elements and data for the parent component
 * @param {Element} el of the current component
 * @returns {object}
 */
function getParent(el) {
  var parentNode = el.parentNode,
    parentComponent = dom.closest(parentNode, '[' + refAttr + ']'),
    parentComponentRef = parentComponent.getAttribute(refAttr);

  return {
    field: dom.closest(parentNode, '[' + references.editableAttribute + ']').getAttribute(references.editableAttribute),
    component: parentComponent,
    ref: parentComponentRef,
    name: references.getComponentNameFromReference(parentComponentRef)
  };
}

/**
 * get previous component in list, if any
 * @param {object} current
 * @param {object} parent
 * @returns {Promise} with {_ref: previous ref} or undefined
 */
function getPrev(current, parent) {
  return db.get(parent.ref).then(function (parentData) {
    var index = _.findIndex(parentData[parent.field], { _ref: current.ref }),
      before = _.take(parentData[parent.field], index),
      prev = _.findLast(before, function (component) {
        return references.getComponentNameFromReference(component._ref) === current.name;
      });

    if (prev) {
      return {
        field: current.field,
        component: dom.find(parent.component, '[' + refAttr + '="' + prev._ref + '"]'),
        ref: prev._ref,
        name: current.name
      };
    }
  });
}

/**
 * get the contents of a wysiwyg field
 * note: if we want to remove / parse / sanitize contents when doing operations,
 * this is the place we should do it
 * @param {Element} el
 * @returns {string}
 */
function getFieldContents(el) {
  return el.innerHTML;
}

/**
 * append text/html to previous component's field
 * @param {string} html
 * @param {object} prev
 * @returns {Promise}
 */
function appendToPrev(html, prev) {
// note: get fresh data from the server
  return edit.getData(prev.ref).then(function (prevData) {
    var prevFieldData = _.get(prevData, prev.field),
      prevFieldHTML = prevFieldData.value,
      throwawayDiv = document.createElement('div'),
      textmodel, fragment;

    // add current field's html to the end of the previous field
    prevFieldHTML += html;

    // pass the full thing through text-model to clean it and merge tags
    textmodel = model.fromElement(dom.create(prevFieldHTML));
    fragment = model.toElement(textmodel);
    throwawayDiv.appendChild(fragment);
    prevFieldData.value = throwawayDiv.innerHTML;

    return edit.savePartial(prevData);
  });
}

/**
 * remove current component from parent
 * @param {object} current
 * @param {object} parent
 * @returns {Promise} new html for the parent component
 */
function removeCurrentFromParent(current, parent) {
  return edit.removeFromParentList({el: current.component, ref: current.ref, parentField: parent.field, parentRef: parent.ref});
}

/**
 * focus on the previous component's field
 * @param {Element} el
 * @param  {object} prev
 * @param {number} textLength
 * @returns {Function}
 */
function focusPreviousComponent(el, prev, textLength) {
  return function () {
    return focus.focus(el, { ref: prev.ref, path: prev.field }).then(function (el) {
      // set caret right before the new text we added
      select(el, { start: el.textContent.length - textLength });
    });
  };
}

/**
 * remove current component, append text to previous component (of the same name)
 * @param {Element} el
 * @returns {Promise|undefined}
 */
function removeComponent(el) {
  var current = getCurrent(el),
    parent = getParent(current.component),
    textLength = el.textContent.length;

  // find the previous component, if any
  return getPrev(current, parent).then(function (prev) {
    if (prev) {
      // there's a previous component with the same name!
      // get the contents of the current field, and append them to the previous component
      return appendToPrev(getFieldContents(el), prev)
        .then(function (html) {
          return removeCurrentFromParent(current, parent)
            .then(render.reloadComponent.bind(null, prev.ref, html))
            .then(focusPreviousComponent(html, prev, textLength));
        });
    }
  });
}

/**
 * add component after current component
 * @param {Element} el
 * @param {string} [text]
 * @returns {Promise}
 */
function addComponent(el, text) {
  var current = getCurrent(el),
    parent = getParent(current.component),
    newData = {};

  // if we're passing data in, set it into the object
  if (text) {
    newData[current.field] = text;
  }

  return edit.createComponent(current.name, newData)
    .then(function (res) { // todo: when we can POST and get back html, handle it here
      var newRef = res._ref;

      return edit.addToParentList({ref: newRef, prevRef: current.ref, parentField: parent.field, parentRef: parent.ref})
        .then(function (newEl) {
          dom.insertAfter(current.component, newEl);
          return render.addComponentsHandlers(newEl)
            .then(function () {
              // focus on the same field in the new component
              focus.focus(newEl, { ref: newRef, path: current.field }).then(function () {
                return newRef;
              });
            });
        });
    });
}

/**
 * add MULTIPLE components after the current component, or at a specific index
 * note: does nothing if components array is empty
 * @param {object} parent
 * @param {array} components (array of matched components)
 * @param {object} [options]
 * @param {object} [options.current] add after current component
 * @param {number} [options.insertIndex] add at a specific index (wins over options.current)
 * @returns {Promise}
 */
function addComponents(parent, components, options) {
  var currentRef, insertIndex;

  options = options || {};
  currentRef = options.current && options.current.ref; // undefined if no current component
  insertIndex = options.insertIndex;

  // first, create the new components
  return Promise.all(_.map(components, function (component) {
    var newComponentData = {};

    if (_.isString(component.value)) {
      newComponentData[component.field] = component.value;
    } else if (_.get(component, 'value.text') && component.sanitize) {
      // text model!
      let throwawayDiv = document.createElement('div'),
        fragment = model.toElement(component.value);

      throwawayDiv.appendChild(fragment);
      newComponentData[component.field] = throwawayDiv.innerHTML;
    } // note: value might be null if we're not passing any actual data into the new component

    return edit.createComponent(component.component, newComponentData);
  })).then(function (newComponents) {
    if (!_.isEmpty(newComponents)) {
      let newRefs = _.map(newComponents, c => c._ref),
        addOptions = {
          refs: newRefs,
          parentField: parent.field,
          parentRef: parent.ref
        };

      if (_.isNumber(insertIndex)) {
        addOptions.insertIndex = insertIndex;
      } else if (currentRef) {
        addOptions.prevRef = currentRef;
      } // otherwise add to the end of the list

      return edit.addMultipleToParentList(addOptions)
        .then(focus.unfocus) // save the current component before re-rendering the parent
        .then(function (newEl) {
          return render.reloadComponent(parent.ref, newEl)
            .then(function () {
              var lastNewComponentRef = _.last(newRefs),
                lastNewComponent = dom.find('[' + refAttr + '="' + lastNewComponentRef + '"]'),
                lastField = _.last(components).field,
                lastGroup = _.last(components).group;

              if (lastField) {
                // focus on the same field (or group, if specified) in the new component
                focus.focus(lastNewComponent, { ref: lastNewComponentRef, path: lastGroup || lastField }).then(function (editable) {
                  selectAfter(editable.lastChild);
                  return lastNewComponentRef;
                });
              }
            });
        });
    }
  });
}

/**
 * split text in a component, creating a new component
 * @param {Element} el
 * @param {object} caret
 * @param {object} observer used to update the current component
 * @returns {Promise}
 */
function splitComponent(el, caret, observer) {
  var textmodel = model.fromElement(dom.create(el.innerHTML.replace(/&nbsp;/g, ' '))),
    // note: we're removing any nonbreaking spaces BEFORE parsing the text
    splitText = model.split(textmodel, caret.start),
    oldText = splitText[0],
    newText = splitText[1],
    oldFragment = model.toElement(oldText),
    newFragment = model.toElement(newText),
    throwawayDiv = document.createElement('div');

  // to get the innerHTML of the document fragment,
  // we first need to append it to a throwaway div.
  // this is not awesome, but is the "best practice"
  throwawayDiv.appendChild(newFragment);

  // now that we have the split elements, put the old one back in and then create the new one
  dom.clearChildren(el); // clear the current children
  el.appendChild(oldFragment); // add the cleaned dom fragment
  observer.setValue(el.innerHTML); // update the current field
  // this is saved automatically when it's unfocused
  return addComponent(el, throwawayDiv.innerHTML);
}

/**
 * remove current component if we're at the beginning of the field
 * and there's a previous component to append it to
 * @param {Element} el
 * @param {KeyboardEvent} e
 * @returns {undefined|Promise}
 */
function handleComponentDeletion(el, e) {
  var caretPos = select(el);

  if (caretPos.start === 0 && caretPos.end === 0) {
    e.preventDefault(); // stop page reload
    return removeComponent(el);
  }
}

/**
 * create new component if we're at the end of the field
 * @param {Element} el
 * @param {object} observer
 * @returns {false|Promise}
 */
function handleComponentCreation(el, observer) {
  var caretPos = select(el); // get text after the cursor, if any

  // if there's stuff after the caret, get it
  if (caretPos.start < el.textContent.length - 1) {
    return splitComponent(el, caretPos, observer);
  } else {
    return addComponent(el);
  }
}

/**
 *
 * @param {boolean} styled
 * @returns {string}
 */
function addStyledClass(styled) {
  return styled ? ' styled' : ''; // note the preceding space!
}

/**
 * Add a bullet (for fake bulleted lists) and set the caret after it
 */
function addBullet() {
  document.execCommand('insertHTML', false, '&bull;&nbsp;');
}

/**
 * Add a line break and set the caret after it
 */
function addLineBreak() {
  document.execCommand('insertHTML', false, '<br><br>');
}

/**
 * match extension names when instantiating medium-editor
 * @param {string} extname e.g. 'italic'
 * @returns {Function}
 */
function findExtension(extname) {
  return function (ext) {
    return ext.name === extname;
  };
}

/**
 * Add binders
 * @param {boolean} enableKeyboardExtras
 * @param {array} pasteRules
 * @returns {{publish: boolean, bind: Function}}
 */
function initWysiwygBinder(enableKeyboardExtras, pasteRules) {
  return {
    publish: true,
    bind: function (el) {
      // this is called when the binder initializes
      var toolbarButtons = safeAttribute.readAttrObject(el, 'data-wysiwyg-buttons'),
        observer = this.observer,
        data = observer.value() || '', // don't print 'undefined' if there's no data
        editor = createEditor(el, toolbarButtons),
        boldExtension = _.find(editor.extensions, findExtension('bold')),
        italicExtension = _.find(editor.extensions, findExtension('italic')),
        strikethoughExtension = _.find(editor.extensions, findExtension('strikethrough')),
        linkExtension = _.find(editor.extensions, findExtension('anchor')),
        removeFormattingExtension = _.find(editor.extensions, findExtension('removeFormat'));

      // apply custom styling to buttons
      if (boldExtension) {
        boldExtension.button.innerHTML = `<img src="${site.get('assetPath')}/media/components/clay-kiln/bold.svg" />`;
      }
      if (italicExtension) {
        italicExtension.button.innerHTML = `<img src="${site.get('assetPath')}/media/components/clay-kiln/italics.svg" />`;
      }
      if (strikethoughExtension) {
        strikethoughExtension.button.innerHTML = `<img src="${site.get('assetPath')}/media/components/clay-kiln/strikethrough.svg" />`;
      }
      if (linkExtension) {
        linkExtension.button.innerHTML = `<img src="${site.get('assetPath')}/media/components/clay-kiln/link.svg" />`;
      }
      if (removeFormattingExtension) {
        removeFormattingExtension.button.innerHTML = `<img src="${site.get('assetPath')}/media/components/clay-kiln/remove-formatting.svg" />`;
      }

      // generate regex from paste rules
      pasteRules = _.map(pasteRules, function (rule) {
        var pre = '^',
          preLink = '(?:<a(?:.*?)>)?',
          post = '$',
          postLink = '(?:</a>)?';

        // regex rule assumptions
        // 1. match FULL STRINGS (not partials), e.g. wrap rule in ^ and $
        if (!rule.match) {
          throw new Error('Paste rule needs regex! ', rule);
        }

        // if `rule.matchLink` is true, match rule AND a link with the rule as its text
        // this allows us to deal with urls that other text editors make into links automatically
        // (e.g. google docs creates links when you paste in urls),
        // but will only return the stuff INSIDE the link text (e.g. the url).
        // For embeds (where you want to grab the url) set matchLink to true,
        // but for components that may contain actual links set matchLink to false
        if (rule.matchLink) {
          rule.match = `${preLink}${rule.match}${postLink}`;
        }

        // create regex
        try {
          rule.match = new RegExp(`${pre}${rule.match}${post}`);
        } catch (e) {
          console.error(e);
          throw e;
        }

        return rule;
      });

      // put the initial data into the editor
      el.innerHTML = data;

      // hide the tier2 buttons when closing the toolbar
      editor.subscribe('hideToolbar', function onHideToolbar() {
        dom.find('.medium-editor-toolbar').classList.remove('show-all');
        dom.find('.medium-editor-toolbar').classList.remove('show-none');
      });

      // persist editor data to data model on input
      editor.subscribe('editableInput', function onEditableInput(e, editable) {
        if (editable) {
          // editable exists when you're typing into the field
          observer.setValue(editable.innerHTML);
        } else if (e.target) {
          // editable doesn't exist (but e.target does) when hitting enter after entering in a link
          observer.setValue(e.target.innerHTML);
        }
      });

      // persist editor data to data model on paste
      editor.subscribe('editablePaste', function onEditablePaste(e, editable) {
        var currentComponent = getCurrent(editable),
          parentComponent = getParent(currentComponent.component),
          components, firstComponent;

        if (_.isEmpty(pasteRules)) {
          // create a fake paste rule that'll put the pasted text into the current component
          components = [{
            component: currentComponent.name,
            field: currentComponent.field,
            value: model.fromElement(dom.create(editable.innerHTML)) // sanitize by default
          }];
        } else {
          components = matchComponents(splitParagraphs(editable.innerHTML), pasteRules, editable);
        }

        // now grab the first component
        firstComponent = _.head(components);

        // first component is the same as current component (or if there's already text in the current component)
        if (firstComponent.component === currentComponent.name) {
          let fragment = model.toElement(firstComponent.value),
            caret = select(editable); // get current caret position

          dom.clearChildren(editable); // clear the current children
          editable.appendChild(fragment); // add the cleaned dom fragment
          observer.setValue(editable.innerHTML);

          select(editable, caret); // set caret after pasted stuff

          // we already handled the first component above, so just insert the rest of them
          // note: if there are no other components, this does nothing
          return addComponents(parentComponent, _.tail(components), { current: currentComponent });
        } else {
          // get index of the current component, so we can insert new components starting there
          return edit.getDataOnly(parentComponent.ref).then(function (parentData) {
            var insertIndex = _.findIndex(parentData[parentComponent.field], item => item._ref === currentComponent.ref);

            // remove current component, then add components from the paste
            return removeCurrentFromParent(currentComponent, parentComponent)
              .then(() => addComponents(parentComponent, components, { insertIndex: insertIndex }));
          });
        }
      });

      editor.subscribe('editableKeydownDelete', function onEditableKeydownDelete(e, editable) {
        if (enableKeyboardExtras) {
          handleComponentDeletion(editable, e);
        }
      });

      editor.subscribe('editableKeydownTab', function onEditableKeydownTab() {
        if (enableKeyboardExtras) {
          addBullet();
        }
      });

      editor.subscribe('editableKeydownEnter', function onEditableKeydownEnter(e, editable) {
        if (enableKeyboardExtras && e.shiftKey) {
          // shift+enter was pressed. add a line break
          addLineBreak();
        } else if (enableKeyboardExtras) {
          // enter was pressed. create a new component if certain conditions are met
          handleComponentCreation(editable, observer);
        } else {
          // close the form?
          focus.unfocus().catch(_.noop);
        }
      });
    }
  };
}

/**
 * Create WYSIWYG text editor.
 * @param {{name: string, el: Element, binders: {}}} result
 * @param {{buttons: Array, styled: boolean, enableKeyboardExtras: boolean}} args  Described in detail below:
 * @param {Array} args.buttons  array of button names (strings) for tooltip, buttons with options are objects rather than strings
 * @param {boolean}  args.styled   apply input styles to contenteditable element
 * @param {boolean}  args.enableKeyboardExtras  enable creating new components on enter, and appending text to previous components on delete, etc
 * @param {Array} args.paste chain of responsibility for parsing pasted content
 * @returns {{}}
 */
module.exports = function (result, args) {
  var name = result.name,
    binders = result.binders,
    buttons = args.buttons,
    styled = args.styled,
    enableKeyboardExtras = args.enableKeyboardExtras,
    pasteRules = args.paste || [],
    field = dom.create(`<label class="input-label">
      <p class="wysiwyg-input${ addStyledClass(styled) }" rv-field="${name}" rv-wysiwyg="${name}.data.value" ${safeAttribute.writeObjectAsAttr('data-wysiwyg-buttons', buttons)}></p>
    </label>`);

  // if more than 5 buttons, put the rest on the second tier
  if (buttons.length > 5) {
    buttons.splice(5, 0, 'tieredToolbar'); // clicking this expands the toolbar with a second tier
  }

  // add the input to the field
  result.el = field;

  // add the binder
  binders.wysiwyg = initWysiwygBinder(enableKeyboardExtras, pasteRules);

  return result;
};
