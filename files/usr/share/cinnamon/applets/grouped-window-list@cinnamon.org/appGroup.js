const Cinnamon = imports.gi.Cinnamon;
const Meta = imports.gi.Meta;
const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const St = imports.gi.St;
const Main = imports.ui.main;
const DND = imports.ui.dnd;
const Tooltips = imports.ui.tooltips;
const PopupMenu = imports.ui.popupMenu;
const Mainloop = imports.mainloop;
const {SignalManager} = imports.misc.signalManager;
const {unref} = imports.misc.util;

const createStore = require('./state');
const {AppMenuButtonRightClickMenu, HoverMenuController, AppThumbnailHoverMenu} = require('./menus');
const {
    FLASH_INTERVAL,
    FLASH_MAX_COUNT,
    MAX_BUTTON_WIDTH,
    BUTTON_BOX_ANIMATION_TIME,
    RESERVE_KEYS,
    TitleDisplay
} = require('./constants');

const _reLetterRtl = new RegExp("\\p{Script=Hebrew}|\\p{Script=Arabic}", "u");
const _reLetter = new RegExp("\\p{L}", "u");
const getTextDirection = function(text) {
    for (const l of text) {
        if (l.match(_reLetterRtl))
            return Clutter.TextDirection.RTL;
        if (l.match(_reLetter))
            return Clutter.TextDirection.LTR;
    }
    return Clutter.TextDirection.None;
}

// returns [x1,x2] so that the area between x1 and x2 is
// centered in length

const center = function(length, naturalLength) {
    const maxLength = Math.min(length, naturalLength);
    const x1 = Math.floor((length - maxLength) / 2);
    const x2 = x1 + maxLength;
    return [x1, x2];
};

const getFocusState = function(metaWindow) {
    if (!metaWindow || metaWindow.minimized) {
        return false;
    }

    if (metaWindow.appears_focused) {
        return true;
    }

    if (global.display.focus_window && metaWindow.is_ancestor_of_transient(global.display.focus_window))
        return true;

    return false;
};

class AppGroup {
    constructor(params) {
        this.state = params.state;
        this.workspaceState = params.workspaceState;
        this.groupState = createStore({
            app: params.app,
            appId: params.appId,
            appName: params.app.get_name(),
            appInfo: params.app.get_app_info(),
            metaWindows: params.metaWindows || [],
            windowCount: params.metaWindows ? params.metaWindows.length : 0,
            lastFocused: params.metaWindow || null,
            isFavoriteApp: !params.metaWindow ? true : params.isFavoriteApp === true,
            autoStartIndex: this.state.autoStartApps.findIndex( app => app.id === params.appId),
            willUnmount: false,
            tooltip: null,
            // Not to be confused with the vertical thumbnail setting, this is for overriding horizontal
            // orientation when there are too many thumbnails to fit the monitor without making them tiny.
            verticalThumbs: false,
            groupReady: false,
            thumbnailMenuEntered: false,
            fileDrag: false,
            pressed: true
        });

        this.groupState.connect({
            isFavoriteApp: () => this.handleFavorite(true),
            getActor: () => this.actor,
            launchNewInstance: (...args) => this.launchNewInstance(...args),
            checkFocusStyle: () => this.checkFocusStyle()
        });

        this.signals = new SignalManager(null);
        this.appKeyTimeout = 0;
        this.flashTimer = 0;

        // TODO: This needs to be in state so it can be updated more reliably.
        this.labelVisiblePref = this.state.settings.titleDisplay !== TitleDisplay.None && this.state.isHorizontal;
        this.drawLabel = this.labelVisiblePref;
        this.progress = 0;

        this.actor =  new Cinnamon.GenericContainer({
            name: 'appButton',
            style_class: 'grouped-window-list-item-box',
            important: true,
            reactive: !this.state.panelEditMode,
            can_focus: true,
            track_hover: true
        });
        this.actor._delegate = this;

        this.progressOverlay = new St.Widget({
            name: 'progressOverlay',
            style_class: 'progress',
            reactive: false,
            important: true,
            show_on_set_parent: false
        });
        this.actor.add_child(this.progressOverlay);

        // Create the app button icon, number label, and text label for titleDisplay
        this.iconBox = new Cinnamon.Slicer({name: 'appMenuIcon'});
        this.actor.add_child(this.iconBox);
        this.setActorAttributes(null, params.metaWindow);

        this.badge = new St.BoxLayout({
            style_class: 'grouped-window-list-badge',
            important: true,
            x_align: St.Align.START,
            y_align: St.Align.MIDDLE,
            show_on_set_parent: false,
        });
        this.numberLabel = new St.Label({
            style_class: 'grouped-window-list-number-label',
            important: true,
            text: '',
            anchor_x: -3 * global.ui_scale,
        });
        this.numberLabel.clutter_text.ellipsize = false;
        this.badge.add(this.numberLabel, {
            x_align: St.Align.START,
            y_align: St.Align.START,
        });
        this.actor.add_child(this.badge);
        this.badge.set_text_direction(St.TextDirection.LTR);

        this.label = new St.Label({
            style_class: 'grouped-window-list-button-label',
            important: true,
            text: '',
            x_align: St.Align.START,
            show_on_set_parent: this.state.settings.titleDisplay > 1
        });
        this.actor.add_child(this.label);

        this.groupState.set({tooltip: new Tooltips.PanelItemTooltip({actor: this.actor}, '', this.state.orientation)});

        this._draggable = new DND._Draggable(this.actor);
        this._draggable.inhibit = !this.state.settings.enableDragging;

        this.signals.connect(this.actor, 'get-preferred-width', (...args) => this.getPreferredWidth(...args));
        this.signals.connect(this.actor, 'get-preferred-height', (...args) => this.getPreferredHeight(...args));
        this.signals.connect(this.actor, 'allocate', (...args) => this.allocate(...args));
        this.signals.connect(this.actor, 'enter-event', (...args) => this.onEnter(...args));
        this.signals.connect(this.actor, 'leave-event', (...args) => this.onLeave(...args));
        this.signals.connect(this.actor, 'button-release-event', (...args) => this.onAppButtonRelease(...args));
        this.signals.connect(this.actor, 'button-press-event', (...args) => this.onAppButtonPress(...args));
        this.signals.connect(this._draggable, 'drag-begin', (...args) => this.onDragBegin(...args));
        this.signals.connect(this._draggable, 'drag-cancelled', (...args) => this.onDragCancelled(...args));

        this.calcWindowNumber();
        this.on_orientation_changed(true);
        this.handleFavorite();
    }

    initThumbnailMenu() {
        this.hoverMenuManager = new HoverMenuController(this.actor, this.groupState);

        this.hoverMenu = new AppThumbnailHoverMenu(this.state, this.groupState);
        this.hoverMenu.actor.hide();

        Main.layoutManager.addChrome(this.hoverMenu.actor, {});

        this.hoverMenu.setVerticalSetting();
        this.hoverMenu.actor.set_style_class_name('');
        this.hoverMenu.box.set_important(true);
        this.hoverMenu.box.set_style_class_name('grouped-window-list-thumbnail-menu');
        this.hoverMenuManager.addMenu(this.hoverMenu);
        this.signals.connect(this.hoverMenu.actor, 'enter-event',
            (...args) => this.hoverMenu.onMenuEnter.call(this.hoverMenu, ...args));
        this.signals.connect(this.hoverMenu.actor, 'leave-event',
            (...args) => this.hoverMenu.onMenuLeave.call(this.hoverMenu, ...args));
        this.signals.connect(this.hoverMenu.actor, 'key-release-event',
            (...args) => this.hoverMenu.onKeyRelease.call(this.hoverMenu, ...args));
        this.signals.connect(this.hoverMenu.actor, 'scroll-event',
            (c, e) => this.state.trigger('cycleWindows', e, this.actor._delegate));
        this.signals.connect(this.hoverMenu.box, 'key-press-event',
            (...args) => this.hoverMenu.onKeyPress.call(this.hoverMenu, ...args));
    }

    initRightClickMenu() {
        const {state, groupState, actor} = this;
        this.rightClickMenu = new AppMenuButtonRightClickMenu({
            state,
            groupState,
            actor
        }, this.state.orientation);
        this.rightClickMenuManager = new PopupMenu.PopupMenuManager({actor});
        this.rightClickMenuManager.addMenu(this.rightClickMenu);
    }

    on_orientation_changed(fromInit) {
        this.actor.set_style_class_name('grouped-window-list-item-box');
        if (this.state.orientation === St.Side.TOP) {
            this.actor.add_style_class_name('top');
        } else if (this.state.orientation === St.Side.BOTTOM) {
            this.actor.add_style_class_name('bottom');
        } else if (this.state.orientation === St.Side.LEFT) {
            this.actor.add_style_class_name('left');
        } else if (this.state.orientation === St.Side.RIGHT) {
            this.actor.add_style_class_name('right');
        }

        if (this.state.appletReady && !fromInit) {
            this.setActorAttributes();
        }

        if (fromInit) this.groupState.set({groupReady: true});
    }

    setActorAttributes(iconSize, metaWindow) {
        if (!iconSize) {
            iconSize = this.state.trigger('getPanelIconSize');
        }
        this.iconSize = iconSize;

        this.actor.style = null;

        const panelHeight = this.state.trigger('getPanelHeight');

        if (this.state.isHorizontal) {
            this.actor.height = panelHeight;
        }
        this.setIcon(metaWindow);
        this.setIconPadding(panelHeight);
        this.setMargin();
    }

    setIconPadding(panelHeight) {
        this.iconBox.style = 'padding: 0px';
        if (!this.state.isHorizontal) return;
        this.actor.style = 'padding-left: 0px; padding-right: 0px;';
    }

    setMargin() {
        const appletActor = this.state.appletActor;
        const direction = this.state.isHorizontal ? 'right' : 'bottom';
        const existingStyle = this.actor.style ? this.actor.style : '';
        let spacing = parseInt(appletActor.get_theme_node().get_length('spacing'));
        if (!spacing) {
            spacing = 6;
        }
        this.actor.style = existingStyle + 'margin-' + direction + ':' + spacing + 'px;';
    }

    setIcon(metaWindow) {
        let icon;

        if (this.groupState.app) {
            if (metaWindow && (!this.state.settings.groupApps || this.groupState.app.is_window_backed())) {
                icon = this.groupState.app.create_icon_texture_for_window(this.iconSize, metaWindow);
            } else {
                icon = this.groupState.app.create_icon_texture(this.iconSize);
            }
        } else {
            icon = new St.Icon({
                icon_name: 'application-default-icon',
                icon_type: St.IconType.FULLCOLOR,
                icon_size: this.iconSize
            });
        }

        const oldChild = this.iconBox.get_child();
        this.iconBox.set_child(icon);

        if (oldChild) oldChild.destroy();
    }

    setText(text) {
        if (text
            && (typeof text === 'string' || text instanceof String)
            && text.length > 0 && this.label) {
            this.label.set_text(text);
        }
    }

    getAttention() {
        if (this._needsAttention) return;

        this._needsAttention = true;
        this.flashButton();
    }

    flashButton() {
        if (!this._needsAttention || !this.actor || this.flashTimer)
            return;

        if (!this.groupState.groupReady && this.groupState.isFavoriteApp)
            return;

        let counter = 0;
        const sc = "grouped-window-list-item-demands-attention";

        this.flashTimer = Mainloop.timeout_add(FLASH_INTERVAL, () => {
            if (!this._needsAttention) {
                this.flashTimer = 0;
                return GLib.SOURCE_REMOVE;
            }

            if (this.actor.has_style_class_name(sc)) {
                this.actor.add_style_class_name("active");
                this.actor.remove_style_class_name(sc);
            }
            else {
                this.actor.remove_style_class_name("active")
                this.actor.add_style_class_name(sc);
            }

            const continueFlashing = (counter++ < FLASH_MAX_COUNT);
            if (!continueFlashing) {
                this.flashTimer = 0;
            }
            return continueFlashing;
        });
    }

    getPreferredWidth(actor, forHeight, alloc) {
        const [iconMinSize, iconNaturalSize] = this.iconBox.get_preferred_width(forHeight);
        const [labelMinSize, labelNaturalSize] = this.label.get_preferred_width(forHeight);
        // The label text starts in the center of the icon, so we should allocate the space
        // needed for the icon plus the space needed for(label - icon/2)
        alloc.min_size = 1 * global.ui_scale;

        const {appId} = this.groupState;

        const allocateForLabel = this.labelVisiblePref ||
                            (this.state.settings.titleDisplay == TitleDisplay.Focused &&
                            this.workspaceState.lastFocusedApp === appId);

        if (this.state.orientation === St.Side.TOP || this.state.orientation === St.Side.BOTTOM) {
            if (allocateForLabel) {
                const max = this.labelVisiblePref && this.groupState.metaWindows.length > 0 ?
                    labelNaturalSize + iconNaturalSize + 6 : 0;
                alloc.natural_size = Math.min(iconNaturalSize + Math.max(max, labelNaturalSize), MAX_BUTTON_WIDTH * global.ui_scale);
            } else {
                alloc.natural_size = iconNaturalSize + 6 * global.ui_scale;
            }
        } else {
            alloc.natural_size = this.state.trigger('getPanelHeight');
        }
    }

    getPreferredHeight(actor, forWidth, alloc) {
        let [iconMinSize, iconNaturalSize] = this.iconBox.get_preferred_height(forWidth);
        let [labelMinSize, labelNaturalSize] = this.label.get_preferred_height(forWidth);
        alloc.min_size = Math.min(iconMinSize, labelMinSize);
        alloc.natural_size = Math.max(iconNaturalSize, labelNaturalSize);
    }

    allocate(actor, box, flags) {
        const allocWidth = box.x2 - box.x1;
        const allocHeight = box.y2 - box.y1;
        const childBox = new Clutter.ActorBox();
        const direction = this.actor.get_text_direction();

        // Set the icon to be left-justified (or right-justified) and centered vertically
        const [minWidth, minHeight, naturalWidth, naturalHeight] = this.iconBox.get_preferred_size();
        const iconYPadding = Math.floor(Math.max(0, allocHeight - naturalHeight) / 2);

        this.drawLabel = this.labelVisiblePref && allocWidth >= naturalWidth + 10 * global.ui_scale;

        childBox.y1 = box.y1 + iconYPadding;
        childBox.y2 = childBox.y1 + Math.min(naturalHeight, allocHeight);

        if (this.drawLabel && this.groupState.metaWindows.length > 0) {
            childBox.x1 = direction === Clutter.TextDirection.LTR ?
                box.x1 + 6 : Math.max(box.x1, box.x2 - 6 - naturalWidth);
            childBox.x2 = Math.min(childBox.x1 + naturalWidth, box.x2);
        } else {
            const offset = this.state.orientation === St.Side.LEFT ? this.actor.style_length('border-left-width') * 2 : 0;
            [childBox.x1, childBox.x2] = center(allocWidth + offset, naturalWidth);
        }

        this.iconBox.allocate(childBox, flags);

        // Set badge position
        const windowCountFactor = this.groupState.windowCount > 9 ? 1.5 : 2;
        const badgeOffset = 2 * global.ui_scale;
        childBox.x1 = childBox.x1 - badgeOffset;
        childBox.x2 = childBox.x1 + (this.numberLabel.width * windowCountFactor);
        childBox.y1 = Math.max(childBox.y1 - badgeOffset, 0);
        childBox.y2 = childBox.y1 + this.badge.get_preferred_height(childBox.get_width())[1];

        this.badge.allocate(childBox, flags);

        // Set label position
        if (this.drawLabel) {
            const textDirection = getTextDirection(this.label.get_text());
            const labelNaturalHeight = this.label.get_preferred_size()[3];
            const labelYPadding = Math.floor(Math.max(0, allocHeight - labelNaturalHeight) / 2);

            childBox.y1 = box.y1 + labelYPadding;
            childBox.y2 = childBox.y1 + Math.min(labelNaturalHeight, allocHeight);

            if (direction === Clutter.TextDirection.LTR) {
                childBox.x1 = Math.min(this.iconBox.x + this.iconBox.width, box.x2);
                childBox.x2 = box.x2;
            } else {
                childBox.x1 = box.x1;
                childBox.x2 = this.iconBox.x;
            }

            // Set text alignment
            if (textDirection === St.TextDirection.LTR)
                this.label.set_style('text-align: left;');
            else if (textDirection === St.TextDirection.RTL)
                this.label.set_style('text-align: right;');
            else
                if (direction === St.TextDirection.LTR)
                    this.label.set_style('text-align: left;');
                else
                    this.label.set_style('text-align: right;');

            this.label.allocate(childBox, flags);
        }

        // Call set_icon_geometry for support of Cinnamon's minimize animation
        if (this.groupState.metaWindows.length > 0 && this.actor.realized) {
            const rect = new Meta.Rectangle();
            [rect.x, rect.y] = this.actor.get_transformed_position();
            [rect.width, rect.height] = this.actor.get_transformed_size();
            this.groupState.metaWindows.forEach( metaWindow => {
                if (metaWindow) {
                    metaWindow.set_icon_geometry(rect);
                }
            });
        }

        if (this.progressOverlay.visible) this.allocateProgress(childBox, flags);
    }

    showLabel(animate = false) {
        if (this.labelVisiblePref
            || !this.label
            || !this.state.isHorizontal
            || this.label.is_finalized()
            || !this.label.realized) {
            return;
        }

        const width = MAX_BUTTON_WIDTH * global.ui_scale;

        this.labelVisiblePref = true;
        if (this.label.text == null) {
            this.label.set_text('');
        }

        if (!animate) {
            this.label.show();
            this.label.width = width;
            return;
        }

        this.label.ease({
            width,
            duration: BUTTON_BOX_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => {
                if (!this.label) return;
                this.label.show();
            }
        });
        return;
    }

    hideLabel() {
        if (!this.label || this.label.is_finalized() || !this.label.realized) return;

        this.label.set_text('');
        this.labelVisiblePref = false;
        this.label.width = 1;
        this.label.hide();
    }

    onEnter() {
        if (this.state.panelEditMode) return false;

        this.actor.add_style_pseudo_class('hover');

        if (!this.hoverMenu) {
            this.initThumbnailMenu();
        }
        this.hoverMenu.onMenuEnter();
    }

    onLeave() {
        this.groupState.pressed = false;

        if (this.state.panelEditMode) return false;

        if (this.hoverMenu) this.hoverMenu.onMenuLeave();
        this.resetHoverStatus();
        this.checkFocusStyle();
    }

    checkFocusStyle() {
        if (this.actor.is_finalized()) return;

        const focused = this.groupState.metaWindows.some( metaWindow => getFocusState(metaWindow) );

        if (focused) {
            this.actor.add_style_pseudo_class('focus');
        }
    }

    resetHoverStatus() {
        if (this.actor.is_finalized()) return;
        this.actor.remove_style_pseudo_class('hover');
    }

    setActiveStatus(state) {
        if (state && !this.actor.has_style_pseudo_class('active')) {
            this.actor.add_style_pseudo_class('active');
        } else {
            this.actor.remove_style_pseudo_class('active');
        }
    }

    averageProgress() {
        const {metaWindows} = this.groupState;
        let total = 0;
        let count = 0;
        metaWindows.forEach( metaWindow => {
            const {progress} = metaWindow;
            if (progress < 1) return;
            total += progress;
            count++;
        });
        return total / count;
    }

    allocateProgress(childBox = null, flags = 0) {
        if (!childBox) childBox = new Clutter.ActorBox();
        childBox.y1 = 0;
        childBox.y2 = this.actor.height;
        if (St.Widget.get_default_direction() === St.TextDirection.RTL) {
            childBox.x1 = Math.max(this.actor.width * ((100 - this.progress) / 100.0), 1.0);
            childBox.x2 = this.actor.width;
        } else {
            childBox.x1 = 0;
            childBox.x2 = Math.max(this.actor.width * (this.progress / 100.0), 1.0);
        }
        this.progressOverlay.allocate(childBox, flags);
    }

    onProgressChange(metaWindow) {
        const progress = this.averageProgress();
        if (progress !== this.progress) {
            this.progress = progress;
            if (this.progress > 0) {
                if (!this.progressOverlay.visible) this.progressOverlay.show();
                this.allocateProgress();
            } else {
                this.progressOverlay.hide();
            }
        }
    }

    onFocusChange(hasFocus) {
        const {appId, metaWindows, lastFocused} = this.groupState;

        if (hasFocus === undefined) {
            hasFocus = this.workspaceState.lastFocusedApp === appId;
        }

        // If any of the windows associated with our app have focus,
        // we should set ourselves to active
        if (hasFocus) {
            this.workspaceState.trigger('updateFocusState', appId);
            this.actor.add_style_pseudo_class('focus');
            this.actor.remove_style_class_name('grouped-window-list-item-demands-attention');
            if (this.hoverMenu) {
                this.hoverMenu.appThumbnails.forEach( thumbnail => thumbnail.setThumbnailDemandsAttention(false) );
            }
            this._needsAttention = false;
        } else {
            this.actor.remove_style_pseudo_class('focus');
        }
        if (metaWindows.length > 0) {
            this.actor.add_style_pseudo_class('active');
        }
        this.resetHoverStatus();
        if (lastFocused) this.handleButtonLabel(lastFocused, hasFocus, true);
    }

    onWindowDemandsAttention(metaWindow) {
        // Prevent apps from indicating attention when they are starting up.
        if (!this.groupState || !this.groupState.groupReady || this.groupState.willUnmount) {
            return;
        }
        
        this.groupState.metaWindows.forEach( window => {
            if (window === metaWindow && !getFocusState(window)) {
                // Even though this may not be the last focused window, we want it to be
                // the window that gets focused when a user responds to an alert.
                this.groupState.set({lastFocused: metaWindow});
                this.handleButtonLabel(metaWindow);
                this.getAttention();
                return true;
            }
        });
        return false;
    }

    onDragBegin() {
        // Keep the drag actor contained within the applet area
        let [x, y] = this.actor.get_transformed_position();
        if (this.state.isHorizontal) {
            this._draggable._overrideY = Math.round(y);
            this._draggable._overrideX = null;
        } else {
            this._draggable._overrideX = Math.round(x);
            this._draggable._overrideY = null;
        }

        if (this.rightClickMenu) this.rightClickMenu.close(false);
        if (this.hoverMenu) this.groupState.trigger('hoverMenuClose');
    }

    onDragCancelled() {
        this.state.trigger('moveLauncher', this);
    }

    handleDragOver(source, actor, x, y, time) {
        if (!this.state.settings.enableDragging
            || actor.name != "xdnd-proxy-actor"
            || this.state.panelEditMode) {
            return DND.DragMotionResult.CONTINUE;
        }
        const nWindows = this.groupState.metaWindows.length;
        if (nWindows > 0 && this.groupState.lastFocused) {
            if (nWindows === 1) {
                Main.activateWindow(this.groupState.lastFocused, global.get_current_time());
            } else {
                if (this.groupState.fileDrag) {
                    this.workspaceState.trigger('closeAllHoverMenus');
                }
                // Open the thumbnail menu and activate the window corresponding to the dragged over thumbnail.
                if (!this.hoverMenu) this.initThumbnailMenu();
                this.groupState.set({fileDrag: true});
                this.hoverMenu.open(true);
            }
        }
        return DND.DragMotionResult.CONTINUE;
    }

    getDragActor() {
        return this.groupState.app.create_icon_texture(this.state.trigger('getPanelHeight') / global.ui_scale);
    }

    // Returns the original actor that should align with the actor
    // we show as the item is being dragged.
    getDragActorSource() {
        return this.actor;
    }

    showOrderLabel(number) {
        this.numberLabel.text = (number + 1).toString();
        this.badge.show();
    }

    launchNewInstance(offload=false) {
        if (offload) {
            try {
                this.groupState.app.launch_offloaded(0, [], -1);
            } catch (e) {
                logError(e, "Could not launch app with dedicated gpu: ");
            }
        } else {
            this.groupState.app.open_new_window(-1);
        }

        this.animate();
    }

    onAppButtonRelease(actor, event) {
        if (!this.groupState.pressed) {
            return;
        }

        const button = event.get_button();
        const nWindows = this.groupState.metaWindows.length;

        const modifiers = Cinnamon.get_event_state(event);
        const ctrlPressed = (modifiers & Clutter.ModifierType.CONTROL_MASK);
        const shiftPressed = (modifiers & Clutter.ModifierType.SHIFT_MASK);

        const shouldStartInstance = (
            (button === 1 && ctrlPressed)
            || (button === 1 && shiftPressed)
            || (button === 1
                && this.groupState.isFavoriteApp
                && nWindows === 0
                && (this.state.settings.leftClickAction === 2 || nWindows < 1))
            || (button === 2
                && this.state.settings.middleClickAction === 2)
        );

        const shouldEndInstance = button === 2
            && this.state.settings.middleClickAction === 3
            && this.groupState.lastFocused
            && nWindows > 0;

        if (shouldStartInstance) {
            this.launchNewInstance();
            return;
        }

        if (shouldEndInstance) {
            this.groupState.lastFocused.delete(global.get_current_time());
            return;
        }

        const handleMinimizeToggle = (win) => {
            if (this.state.settings.onClickThumbs && nWindows > 1) {
                if (!this.hoverMenu) this.initThumbnailMenu();
                if (this.hoverMenu.isOpen) {
                    this.hoverMenu.close();
                } else {
                    this.hoverMenu.open();
                }
                if (this.state.lastOverlayPreview) {
                    this.hoverMenu.appThumbnails[0].destroyOverlayPreview();
                    this.hoverMenu.close(true);
                }
                return;
            }
            if (win.appears_focused) {
                win.minimize();
            } else {
                Main.activateWindow(win, global.get_current_time());
            }
        };

        if (button === 1) {
            if (this.state.settings.leftClickAction === 1) {
                return;
            }
            if (this.state.settings.leftClickAction === 3 && nWindows > 1) {
                let foundActive = false;
                for (let i = 0, len = nWindows; i < len; i++) {
                    if (
                        this.groupState.lastFocused &&
                        this.groupState.metaWindows[i] === this.groupState.lastFocused
                    ) {
                        if (this.groupState.metaWindows[i].appears_focused) {
                            this.state.trigger("cycleWindows", null, this.actor._delegate);
                        } else {
                            handleMinimizeToggle(this.groupState.metaWindows[i]);
                        }
                        foundActive = true;
                        break;
                    }
                }
                if (!foundActive) {
                    handleMinimizeToggle(this.groupState.metaWindows[0]);
                }
                return;
            }
            if (this.hoverMenu) this.hoverMenu.shouldOpen = false;
            if (this.rightClickMenu && this.rightClickMenu.isOpen) {
                this.rightClickMenu.toggle();
            }
            if (nWindows === 1) {
                handleMinimizeToggle(this.groupState.metaWindows[0]);
            } else {
                let actionTaken = false;
                for (let i = 0, len = nWindows; i < len; i++) {
                    if (this.groupState.lastFocused && this.groupState.metaWindows[i] === this.groupState.lastFocused) {
                        handleMinimizeToggle(this.groupState.metaWindows[i]);
                        actionTaken = true;
                        break;
                    }
                }
                if (!actionTaken) {
                    handleMinimizeToggle(this.groupState.metaWindows[0]);
                }
            }
        } else if (button === 3) {
            if (!this.rightClickMenu) this.initRightClickMenu();
            if (!this.rightClickMenu.isOpen) {
                this.workspaceState.trigger('closeAllRightClickMenus', () => {
                    this.workspaceState.trigger('closeAllHoverMenus', () => {
                        this.rightClickMenu.toggle();
                    });
                });
            } else {
                this.workspaceState.trigger('closeAllRightClickMenus', this.workspaceState.trigger('closeAllHoverMenus'));
            }
        }
        if (this.hoverMenu) this.hoverMenu.onButtonPress();
    }

    onAppButtonPress(actor, event) {
        const button = event.get_button();
        this.groupState.pressed = true;

        if (button === 3) return true;

        return false;
    }

    onAppKeyPress() {
        if (this.groupState.isFavoriteApp && this.groupState.metaWindows.length === 0) {
            this.launchNewInstance();
        } else {
            if (this.appKeyTimeout) {
                clearTimeout(this.appKeyTimeout);
                this.appKeyTimeout = 0;
            }
            if (this.groupState.metaWindows.length > 1) {
                if (!this.hoverMenu) this.initThumbnailMenu();
                this.hoverMenu.open(true);
            } else {
                this.workspaceState.trigger('closeAllHoverMenus');
            }
            this.windowHandle();
            this.appKeyTimeout = setTimeout(() => {
                if (this.groupState.thumbnailMenuEntered) {
                    clearTimeout(this.appKeyTimeout);
                    this.appKeyTimeout = 0;
                    return;
                }
                if (this.hoverMenu) {
                    this.hoverMenu.close(true);
                }
                this.appKeyTimeout = 0;
            }, this.state.settings.showAppsOrderTimeout);
        }
    }

    windowHandle() {
        if (this.groupState.lastFocused.appears_focused) {
            if (this.groupState.metaWindows.length > 1) {
                let nextWindow = null;
                for (let i = 0, max = this.groupState.metaWindows.length - 1; i < max; i++) {
                    if (this.groupState.metaWindows[i] === this.groupState.lastFocused) {
                        nextWindow = this.groupState.metaWindows[i + 1];
                        break;
                    }
                }
                if (nextWindow === null) {
                    nextWindow = this.groupState.metaWindows[0];
                }
                Main.activateWindow(nextWindow, global.get_current_time());
            } else {
                this.groupState.lastFocused.minimize();
                this.actor.remove_style_pseudo_class('focus');
            }
        } else {
            if (this.groupState.lastFocused.minimized) {
                this.groupState.lastFocused.unminimize();
            }
            const ws = this.groupState.lastFocused.get_workspace().index();
            if (ws !== global.workspace_manager.get_active_workspace_index()) {
                global.workspace_manager.get_workspace_by_index(ws).activate(global.get_current_time());
            }
            Main.activateWindow(this.groupState.lastFocused, global.get_current_time());
            this.actor.add_style_pseudo_class('focus');
        }
    }

    windowAdded(metaWindow) {
        const {metaWindows, trigger, set} = this.groupState;
        const refWindow = metaWindows.indexOf(metaWindow);
        if (metaWindow) {
            this.signals.connect(metaWindow, 'notify::title', (...args) => this.onWindowTitleChanged(...args));
            this.signals.connect(metaWindow, 'notify::appears-focused', (...args) => this.onFocusWindowChange(...args));
            this.signals.connect(metaWindow, 'notify::gtk-application-id', (w) => this.onAppChange(w));
            this.signals.connect(metaWindow, 'notify::wm-class', (w) => this.onAppChange(w));
            this.signals.connect(metaWindow, 'unmanaged', (w) => this.onAppChange(w));

            this.signals.connect(metaWindow, 'notify::icon', (w) => this.setIcon(w));

            if (metaWindow.progress !== undefined) {
                // Check if GWL is starting with pre-existing windows that have progress,
                // and defer to the next tick in case the actor isn't on the stage yet.
                if (metaWindow.progress > 0 || this.progress > 0) {
                    setTimeout(() => this.onProgressChange(), 0);
                } else {
                    this.progress = 0;
                }
                this.signals.connect(metaWindow, 'notify::progress', () => this.onProgressChange(metaWindow));
            }

            // Set the initial button label as not all windows will get updated via signals initially.
            if (this.state.settings.titleDisplay > 1) {
                this.onWindowTitleChanged(metaWindow);
            }
            if (refWindow === -1) {
                metaWindows.push(metaWindow);
                if (this.hoverMenu) trigger('addThumbnailToMenu', metaWindow);
            }

            // update icon using recent window for cases when the first window of an app doesn't have an icon. e.g: VirtualBox VM
            this.setIcon(metaWindow)

            this.calcWindowNumber();
            this.onFocusChange();
        }
        set({
            metaWindows,
            lastFocused: metaWindow
        });
        this.handleFavorite();
    }

    windowRemoved(metaWorkspace, metaWindow, refWindow, cb) {
        if (refWindow === -1) return;

        this.signals.disconnect('notify::title', metaWindow);
        this.signals.disconnect('notify::appears-focused', metaWindow);
        this.signals.disconnect('notify::gtk-application-id', metaWindow);
        this.signals.disconnect('notify::wm-class', metaWindow);

        this.groupState.metaWindows.splice(refWindow, 1);

        if (this.progressOverlay.visible) this.onProgressChange();

        if (this.groupState.metaWindows.length > 0 && !this.groupState.willUnmount) {
            this.onWindowTitleChanged(this.groupState.lastFocused);
            this.groupState.set({
                metaWindows: this.groupState.metaWindows,
                lastFocused: this.groupState.metaWindows[this.groupState.metaWindows.length - 1]
            }, true);
            if (this.hoverMenu) this.groupState.trigger('removeThumbnailFromMenu', metaWindow);
            this.calcWindowNumber();
        } else {
            // This is the last window, so this group needs to be destroyed. We'll call back windowRemoved
            // in workspace to put the final nail in the coffin.
            if (typeof cb === 'function') {
                if (this.hoverMenu && this.groupState.isFavoriteApp) {
                    this.groupState.trigger('removeThumbnailFromMenu', metaWindow);
                }
                cb(this.groupState.appId, this.groupState.isFavoriteApp);
            }
        }
    }

    onAppChange(metaWindow) {
        if (!this.workspaceState) return;

        this.workspaceState.trigger('windowRemoved', metaWindow);
        this.workspaceState.trigger('windowAdded', metaWindow);
    }

    onWindowTitleChanged(metaWindow, refresh) {
        if (this.groupState.willUnmount || !this.state.settings) {
            return;
        }

        const shouldHideLabel = this.state.settings.titleDisplay === TitleDisplay.None
            || !this.state.isHorizontal;

        if (shouldHideLabel) {
            this.setText('');
        }

        if (!refresh
            && (!metaWindow
                || !metaWindow.title
                || (this.groupState.metaWindows.length === 0 && this.groupState.isFavoriteApp)
                    || !this.state.isHorizontal)) {
            this.hideLabel();
            return;
        }

        if ((metaWindow.lastTitle && metaWindow.lastTitle === metaWindow.title)
            && !refresh
            && shouldHideLabel) {
            return;
        }
        metaWindow.lastTitle = metaWindow.title;

        if (this.hoverMenu) {
            const thumbnail = this.hoverMenu.appThumbnails.find(
                thumbnail => thumbnail.metaWindow === metaWindow
            );
            if (thumbnail) {
                thumbnail.labelContainer.child.set_text(metaWindow.title);
            }
        }

        this.groupState.set({
            appName: this.groupState.app.get_name()
        });

        this.handleButtonLabel(metaWindow);
    }

    onFocusWindowChange(metaWindow) {
        if (this.groupState.metaWindows.length === 0) return;

        const hasFocus = getFocusState(metaWindow);
        if (hasFocus && this.groupState.hasOwnProperty('lastFocused')) {
            this.workspaceState.set({lastFocusedApp: this.groupState.appId});
            this.groupState.set({lastFocused: metaWindow});
        }
        this.onFocusChange(hasFocus);

        if (this.state.settings.sortThumbs && this.hoverMenu) {
            this.hoverMenu.addThumbnail(metaWindow);
        }
    }

    handleButtonLabel(metaWindow, focus, animate = false) {
        if (this.state.settings.titleDisplay === TitleDisplay.None) {
            return;
        }

        if (!metaWindow || this.groupState.metaWindows.length === 0) {
            this.hideLabel();
        } else if (this.state.settings.titleDisplay === TitleDisplay.Title) {
            this.setText(metaWindow.title);
            this.showLabel(animate);
        } else if (this.state.settings.titleDisplay === TitleDisplay.App) {
            if (this.groupState.appName) {
                this.setText(this.groupState.appName);
                this.showLabel(animate);
            }
        } else if (this.state.settings.titleDisplay === TitleDisplay.Focused) {
            this.setText(metaWindow.title);
            if (focus === undefined) focus = getFocusState(metaWindow);
            if (focus
                && this.groupState.metaWindows.length > 0) {
                this.showLabel(animate);
            // If a skip-taskbar window is focused from this group, do nothing.
            // Show the last trackable window's label because the application is focused.
            } else if (global.display.focus_window
                && this.groupState.appId.indexOf(global.display.focus_window.wm_class.toLowerCase()) === -1) {
                this.hideLabel();
            }
        }
    }

    handleFavorite(changed) {
        if (this.actor.is_finalized()) return;

        if (changed) {
            setTimeout(() => this.workspaceState.trigger('updateAppGroupIndexes', this.groupState.appId), 0);
        }

        if (this.groupState.metaWindows.length === 0 && this.state.appletReady) {
            if (this.hoverMenu) this.hoverMenu.close();
            this.onLeave();
            return;
        }
        this.onWindowTitleChanged(this.groupState.lastFocused);
        this.onFocusChange();
        this.checkFocusStyle();
    }

    calcWindowNumber() {
        if (this.groupState.willUnmount) return;

        const windowCount = this.groupState.metaWindows ? this.groupState.metaWindows.length : 0;
        this.numberLabel.text = windowCount.toString();

        this.groupState.set({windowCount});

        if (this.state.settings.numDisplay) {
            if (windowCount <= 1) {
                this.badge.hide();
            } else {
                this.badge.show();

            }
        } else {
            this.badge.hide();
        }
    }

    handleTitleDisplayChange() {
        this.groupState.metaWindows.forEach(
            win => this.onWindowTitleChanged(win, true)
        );
    }

    animate() {
        const effect = this.state.settings.launcherAnimationEffect;

        if (effect === 1) return;
        else if (effect === 2) {
            this.iconBox.set_z_rotation_from_gravity(0.0, Clutter.Gravity.CENTER);
            this.iconBox.ease({
                opacity: 70,
                duration: 200,
                mode: Clutter.AnimationMode.LINEAR,
                onStopped: () => {
                   this.iconBox.ease({
                        opacity: 255,
                        duration: 200,
                        mode: Clutter.AnimationMode.LINEAR,
                    });
                }
            });
        } else if (effect === 3) {
            this.iconBox.set_pivot_point(0.5, 0.5);
            this.iconBox.ease({
                scale_x: 0.8,
                scale_y: 0.8,
                duration: 175,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: () => {
                    this.iconBox.ease({
                        scale_x: 1.1,
                        scale_y: 1.1,
                        duration: 175,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        onStopped: () => {
                            this.iconBox.ease({
                                scale_x: 1.0,
                                scale_y: 1.0,
                                duration: 50,
                                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                            });
                        }
                    });
                }
            });
        }
    }

    destroy(skipRefCleanup) {
        this.signals.disconnectAllSignals();
        this.groupState.set({willUnmount: true});

        if (this.flashTimer > 0) {
            Mainloop.source_remove(this.flashTimer);
            this.flashTimer = 0;
        }

        if (this.rightClickMenu) {
            if (this.rightClickMenu.isOpen) {
                this.rightClickMenu.close();
            }
            this.rightClickMenu.destroy();
        }

        if (this.hoverMenu) {
            Main.layoutManager.removeChrome(this.hoverMenu.actor);
            this.hoverMenu.destroy();
        }

        this.workspaceState.trigger('removeChild', this.actor);
        this.actor.destroy();

        if (!skipRefCleanup) {
            this.groupState.destroy();
            unref(this, RESERVE_KEYS);
        }
    }
}

module.exports = AppGroup;
