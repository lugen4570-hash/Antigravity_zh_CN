'use strict';

function translateMenuLabel(raw, translator) {
  if (typeof raw !== 'string' || !raw) return raw;
  const direct = translator.translate(raw);
  if (direct !== raw) return direct;
  if (raw.includes('&')) {
    const clean = raw.replace(/&/g, '');
    const translated = translator.translate(clean);
    if (translated !== clean) return translated;
  }
  return raw;
}

function findAccessorDescriptor(obj, prop) {
  let cur = obj;
  while (cur && cur !== Object.prototype) {
    const desc = Object.getOwnPropertyDescriptor(cur, prop);
    if (desc) return desc;
    cur = Object.getPrototypeOf(cur);
  }
  return null;
}

function createRawLabelProxy(item) {
  return new Proxy(item, {
    get(target, prop, receiver) {
      if (prop === 'label' && typeof target.__agyRawLabel === 'string') {
        return target.__agyRawLabel;
      }
      const val = Reflect.get(target, prop, receiver);
      return typeof val === 'function' ? val.bind(target) : val;
    },
  });
}

function wrapMenuItem(item, translator) {
  if (!item || typeof item !== 'object') return;
  if (!item.__agyWrapped) {
    item.__agyWrapped = true;
    const desc = findAccessorDescriptor(item, 'label');
    const origGet = desc && desc.get;
    const origSet = desc && desc.set;
    let fallbackVal = typeof item.label === 'string' ? item.label : '';
    item.__agyRawLabel = fallbackVal;

    if (origGet && origSet) {
      Object.defineProperty(item, 'label', {
        configurable: true,
        enumerable: true,
        get() {
          return origGet.call(this);
        },
        set(nextVal) {
          this.__agyRawLabel = nextVal;
          origSet.call(this, translateMenuLabel(nextVal, translator));
        },
      });
    } else if (!desc || desc.writable || desc.configurable) {
      Object.defineProperty(item, 'label', {
        configurable: true,
        enumerable: true,
        get() {
          return fallbackVal;
        },
        set(nextVal) {
          this.__agyRawLabel = nextVal;
          fallbackVal = translateMenuLabel(nextVal, translator);
        },
      });
    }

    if (typeof item.click === 'function' && !item.__agyClickWrapped) {
      const origClick = item.click;
      item.__agyClickWrapped = true;
      item.click = function wrappedClick(menuItemArg, focusedWindow, event) {
        const targetItem = menuItemArg === item ? createRawLabelProxy(item) : menuItemArg;
        return origClick.call(this, targetItem, focusedWindow, event);
      };
    }

    if (typeof item.toolTip === 'string' && item.toolTip) {
      item.toolTip = translateMenuLabel(item.toolTip, translator);
    }
  }

  // Trigger translation on initial/current raw label
  if (typeof item.__agyRawLabel === 'string') {
    item.label = item.__agyRawLabel;
  }

  if (item.submenu) {
    translateMenu(item.submenu, translator);
  }
}

function wrapMenuItemsFind(menu) {
  if (!menu || !Array.isArray(menu.items) || menu.items.__agyFindWrapped) return;
  const origFind = menu.items.find;
  Object.defineProperty(menu.items, '__agyFindWrapped', { value: true });
  Object.defineProperty(menu.items, 'find', {
    configurable: true,
    value(predicate, thisArg) {
      const direct = origFind.call(this, predicate, thisArg);
      if (direct !== undefined) return direct;
      if (typeof predicate !== 'function') return undefined;
      for (let i = 0; i < this.length; i += 1) {
        const item = this[i];
        if (item && typeof item.__agyRawLabel === 'string') {
          if (predicate.call(thisArg, createRawLabelProxy(item), i, this)) {
            return item;
          }
        }
      }
      return undefined;
    },
  });
}

function translateMenu(menu, translator) {
  if (!menu || !Array.isArray(menu.items)) return menu;
  wrapMenuItemsFind(menu);
  for (const item of menu.items) {
    wrapMenuItem(item, translator);
  }
  return menu;
}

function translateDialogOptions(options, translator) {
  if (!options || typeof options !== 'object') return options;
  const next = { ...options };
  if (typeof next.title === 'string') next.title = translator.translate(next.title);
  if (typeof next.message === 'string') next.message = translator.translate(next.message);
  if (typeof next.detail === 'string') next.detail = translator.translate(next.detail);
  if (typeof next.checkboxLabel === 'string') next.checkboxLabel = translator.translate(next.checkboxLabel);
  if (Array.isArray(next.buttons)) {
    next.buttons = next.buttons.map((b) => (typeof b === 'string' ? translator.translate(b) : b));
  }
  return next;
}

function installMenuHooks(electron, translator) {
  if (!electron || electron.__agyMenuHooked) return;
  electron.__agyMenuHooked = true;

  const { Menu, Tray, dialog } = electron;

  if (Menu) {
    if (typeof Menu.setApplicationMenu === 'function') {
      const origSetAppMenu = Menu.setApplicationMenu.bind(Menu);
      Menu.setApplicationMenu = function wrappedSetApplicationMenu(menu) {
        if (menu) translateMenu(menu, translator);
        return origSetAppMenu(menu);
      };
    }

    if (Menu.prototype && typeof Menu.prototype.insert === 'function') {
      const origInsert = Menu.prototype.insert;
      Menu.prototype.insert = function wrappedInsert(pos, menuItem) {
        wrapMenuItem(menuItem, translator);
        return origInsert.call(this, pos, menuItem);
      };
    }

    if (Menu.prototype && typeof Menu.prototype.popup === 'function') {
      const origPopup = Menu.prototype.popup;
      Menu.prototype.popup = function wrappedPopup(options) {
        translateMenu(this, translator);
        return origPopup.call(this, options);
      };
    }

    const existingAppMenu = typeof Menu.getApplicationMenu === 'function' ? Menu.getApplicationMenu() : null;
    if (existingAppMenu) {
      translateMenu(existingAppMenu, translator);
    }
  }

  if (Tray && Tray.prototype) {
    if (typeof Tray.prototype.setContextMenu === 'function') {
      const origSetContextMenu = Tray.prototype.setContextMenu;
      Tray.prototype.setContextMenu = function wrappedSetContextMenu(menu) {
        if (menu) translateMenu(menu, translator);
        return origSetContextMenu.call(this, menu);
      };
    }
    if (typeof Tray.prototype.setToolTip === 'function') {
      const origSetToolTip = Tray.prototype.setToolTip;
      Tray.prototype.setToolTip = function wrappedSetToolTip(tip) {
        return origSetToolTip.call(this, translator.translate(tip));
      };
    }
  }

  if (dialog) {
    if (typeof dialog.showMessageBox === 'function') {
      const origShowMessageBox = dialog.showMessageBox.bind(dialog);
      dialog.showMessageBox = function wrappedShowMessageBox(winOrOpts, maybeOpts) {
        if (maybeOpts !== undefined) {
          return origShowMessageBox(winOrOpts, translateDialogOptions(maybeOpts, translator));
        }
        return origShowMessageBox(translateDialogOptions(winOrOpts, translator));
      };
    }
    if (typeof dialog.showMessageBoxSync === 'function') {
      const origShowMessageBoxSync = dialog.showMessageBoxSync.bind(dialog);
      dialog.showMessageBoxSync = function wrappedShowMessageBoxSync(winOrOpts, maybeOpts) {
        if (maybeOpts !== undefined) {
          return origShowMessageBoxSync(winOrOpts, translateDialogOptions(maybeOpts, translator));
        }
        return origShowMessageBoxSync(translateDialogOptions(winOrOpts, translator));
      };
    }
  }
}

module.exports = {
  installMenuHooks,
  translateMenu,
  translateDialogOptions,
};
