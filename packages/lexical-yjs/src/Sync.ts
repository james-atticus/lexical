/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {mutex as Mutex} from 'lib0/mutex';

import {$createTextNode, ElementNode, LexicalEditor, LexicalNode, NodeKey, TextNode} from 'lexical';
import * as buf from 'lib0/buffer';
import {simpleDiff} from 'lib0/diff';
import * as dom from 'lib0/dom';
import * as environment from 'lib0/environment';
import * as error from 'lib0/error';
import * as eventloop from 'lib0/eventloop';
import * as sha256 from 'lib0/hash/sha256';
import * as math from 'lib0/math';
import {createMutex} from 'lib0/mutex';
import * as random from 'lib0/random';
import * as set from 'lib0/set';
import * as PModel from 'prosemirror-model';
import {
  AllSelection,
  EditorState,
  Plugin,
  TextSelection,
  Transaction,
} from 'prosemirror-state'; // eslint-disable-line
import {EditorView} from 'prosemirror-view'; // eslint-disable-line
import * as Y from 'yjs';

import {Binding, ExcludedProperties} from './Bindings';
import {$syncPropertiesFromYjs,isExcludedProperty} from './Utils';

// sync-plugin.js

export const isVisible = (item: Y.Item, snapshot?: Y.Snapshot): boolean =>
  snapshot === undefined
    ? !item.deleted
    : snapshot.sv.has(item.id.client) &&
      /** @type {number} */
      snapshot.sv.get(item.id.client)! > item.id.clock &&
      !Y.isDeleted(snapshot.ds, item.id);

/**
 * Either a node if type is YXmlElement or an Array of text nodes if YXmlText
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LexicalMapping = Map<Y.AbstractType<any>, LexicalNode | Array<TextNode>>;

interface ColorDef {
  light: string;
  dark: string;
}

interface YSyncOpts {
  colors?: Array<ColorDef>;
  colorMapping?: Map<string, ColorDef>;
  permanentUserData?: Y.PermanentUserData | null;
  mapping?: LexicalMapping;
  onFirstRender?: VoidFunction;
}

const defaultColors: ColorDef[] = [{dark: '#ecd444', light: '#ecd44433'}];

const getUserColor = (
  colorMapping: Map<string, ColorDef>,
  colors: ColorDef[],
  user: string,
): ColorDef => {
  // @todo do not hit the same color twice if possible
  if (!colorMapping.has(user)) {
    if (colorMapping.size < colors.length) {
      const usedColors = set.create();
      colorMapping.forEach((color) => usedColors.add(color));
      colors = colors.filter((color) => !usedColors.has(color));
    }
    colorMapping.set(user, random.oneOf(colors));
  }
  return colorMapping.get(user)!;
};

/**
 * This plugin listens to changes in prosemirror view and keeps yXmlState and view in sync.
 *
 * This plugin also keeps references to the type and the shared document so other plugins can access it.
 */
export const ySyncPlugin = (
  yXmlFragment: Y.XmlFragment,
  {
    colors = defaultColors,
    colorMapping = new Map(),
    permanentUserData = null,
    onFirstRender = () => {},
    mapping,
  }: YSyncOpts = {},
) => {
  let initialContentChanged = false;
  const binding = new LexicalBinding(yXmlFragment, mapping);
  const plugin = new Plugin({
    key: ySyncPluginKey,
    props: {
      editable: (state) => {
        const syncState = ySyncPluginKey.getState(state);
        return syncState.snapshot == null && syncState.prevSnapshot == null;
      },
    },
    state: {
      apply: (tr, pluginState) => {
        const change = tr.getMeta(ySyncPluginKey);
        if (change !== undefined) {
          pluginState = Object.assign({}, pluginState);
          for (const key in change) {
            pluginState[key] = change[key];
          }
        }
        pluginState.addToHistory = tr.getMeta('addToHistory') !== false;
        // always set isChangeOrigin. If undefined, this is not change origin.
        pluginState.isChangeOrigin =
          change !== undefined && !!change.isChangeOrigin;
        pluginState.isUndoRedoOperation =
          change !== undefined &&
          !!change.isChangeOrigin &&
          !!change.isUndoRedoOperation;
        if (binding.prosemirrorView !== null) {
          if (
            change !== undefined &&
            (change.snapshot != null || change.prevSnapshot != null)
          ) {
            // snapshot changed, rerender next
            eventloop.timeout(0, () => {
              if (binding.prosemirrorView == null) {
                return;
              }
              if (change.restore == null) {
                binding._renderSnapshot(
                  change.snapshot,
                  change.prevSnapshot,
                  pluginState,
                );
              } else {
                binding._renderSnapshot(
                  change.snapshot,
                  change.snapshot,
                  pluginState,
                );
                // reset to current prosemirror state
                delete pluginState.restore;
                delete pluginState.snapshot;
                delete pluginState.prevSnapshot;
                binding.mux(() => {
                  binding._prosemirrorChanged(
                    binding.prosemirrorView!.state.doc,
                  );
                });
              }
            });
          }
        }
        return pluginState;
      },
      /**
       * @returns {any}
       */
      init: (_initargs, _state) => {
        return {
          addToHistory: true,
          binding,
          colorMapping,
          colors,
          doc: yXmlFragment.doc,
          isChangeOrigin: false,
          isUndoRedoOperation: false,
          permanentUserData,
          prevSnapshot: null,
          snapshot: null,
          type: yXmlFragment,
        };
      },
    },
    view: (view) => {
      binding.initView(view);
      if (mapping == null) {
        // force rerender to update the bindings mapping
        binding._forceRerender();
      }
      onFirstRender();
      return {
        destroy: () => {
          binding.destroy();
        },
        update: () => {
          const pluginState = plugin.getState(view.state);
          if (
            pluginState.snapshot == null &&
            pluginState.prevSnapshot == null
          ) {
            if (
              // If the content doesn't change initially, we don't render anything to Yjs
              // If the content was cleared by a user action, we want to catch the change and
              // represent it in Yjs
              initialContentChanged ||
              view.state.doc.content.findDiffStart(
                view.state.doc.type.createAndFill()!.content,
              ) !== null
            ) {
              initialContentChanged = true;
              if (
                pluginState.addToHistory === false &&
                !pluginState.isChangeOrigin
              ) {
                const yUndoPluginState = yUndoPluginKey.getState(view.state);
                /**
                 * @type {Y.UndoManager}
                 */
                const um = yUndoPluginState && yUndoPluginState.undoManager;
                if (um) {
                  um.stopCapturing();
                }
              }
              binding.mux(() => {
                /** @type {Y.Doc} */ pluginState.doc.transact((tr) => {
                  tr.meta.set('addToHistory', pluginState.addToHistory);
                  binding._prosemirrorChanged(view.state.doc);
                }, ySyncPluginKey);
              });
            }
          }
        },
      };
    },
  });
  return plugin;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const restoreRelativeSelection = (
  tr: any,
  relSel: any,
  binding: LexicalBinding,
) => {
  if (relSel !== null && relSel.anchor !== null && relSel.head !== null) {
    if (relSel.type === 'all') {
      tr.setSelection(new AllSelection(tr.doc));
    } else {
      const anchor = relativePositionToAbsolutePosition(
        binding.doc,
        binding.type,
        relSel.anchor,
        binding.mapping,
      );
      const head = relativePositionToAbsolutePosition(
        binding.doc,
        binding.type,
        relSel.head,
        binding.mapping,
      );
      if (anchor !== null && head !== null) {
        tr = tr.setSelection(TextSelection.create(tr.doc, anchor, head));
      }
    }
  }
};

export const getRelativeSelection = (
  pmbinding: LexicalBinding,
  state: EditorState,
) => ({
  anchor: absolutePositionToRelativePosition(
    state.selection.anchor,
    pmbinding.type,
    pmbinding.mapping,
  ),
  head: absolutePositionToRelativePosition(
    state.selection.head,
    pmbinding.type,
    pmbinding.mapping,
  ),
  type: /** @type {any} */ state.selection.jsonID,
});

/**
 * Binding for prosemirror.
 *
 * @protected
 */
export class LexicalBinding {
  type: Y.XmlFragment;
  prosemirrorView: EditorView | null;
  editor: LexicalEditor;
  mux: Mutex;
  mapping: LexicalMapping;
  nodeProperties: Map<string, Array<string>>;
  excludedProperties: ExcludedProperties;
  _observeFunction: (
    events: Array<Y.YEvent<any>>,
    transaction: Y.Transaction,
  ) => void;
  doc: Y.Doc;
  beforeTransactionSelection: Selection | null;
  beforeAllTransactions: () => void;
  afterAllTransactions: () => void;
  _domSelectionInView: boolean | null;

  constructor(
    yXmlFragment: Y.XmlFragment,
    editor: LexicalEditor,
    mapping: LexicalMapping = new Map(),
    excludedProperties: ExcludedProperties = new Map(),
  ) {
    this.type = yXmlFragment;
    /**
     * this will be set once the view is created
     * @type {any}
     */
    this.prosemirrorView = null;
    this.editor = editor;
    this.mux = createMutex();
    this.mapping = mapping;
    this.nodeProperties = new Map();
    this.excludedProperties = excludedProperties;
    this._observeFunction = this._typeChanged.bind(this);
    /**
     * @type {Y.Doc}
     */
    // @ts-ignore
    this.doc = yXmlFragment.doc;
    /**
     * current selection as relative positions in the Yjs model
     */
    this.beforeTransactionSelection = null;
    this.beforeAllTransactions = () => {
      if (
        this.beforeTransactionSelection === null &&
        this.prosemirrorView != null
      ) {
        this.beforeTransactionSelection = getRelativeSelection(
          this,
          this.prosemirrorView.state,
        );
      }
    };
    this.afterAllTransactions = () => {
      this.beforeTransactionSelection = null;
    };
    this._domSelectionInView = null;
  }

  /**
   * Create a transaction for changing the prosemirror state.
   */
  get _tr(): Transaction {
    return this.prosemirrorView!.state.tr.setMeta('addToHistory', false);
  }

  _isLocalCursorInView() {
    if (!this.prosemirrorView!.hasFocus()) {
      return false;
    }
    if (environment.isBrowser && this._domSelectionInView === null) {
      // Calculate the domSelectionInView and clear by next tick after all events are finished
      eventloop.timeout(0, () => {
        this._domSelectionInView = null;
      });
      this._domSelectionInView = this._isDomSelectionInView();
    }
    return this._domSelectionInView;
  }

  _isDomSelectionInView() {
    const selection = this.prosemirrorView!._root.getSelection();

    if (selection == null || selection.anchorNode == null) {
      return false;
    }

    const range = this.prosemirrorView!._root.createRange();
    range.setStart(selection.anchorNode, selection.anchorOffset);
    range.setEnd(selection.focusNode, selection.focusOffset);

    // This is a workaround for an edgecase where getBoundingClientRect will
    // return zero values if the selection is collapsed at the start of a newline
    // see reference here: https://stackoverflow.com/a/59780954
    const rects = range.getClientRects();
    if (rects.length === 0) {
      // probably buggy newline behavior, explicitly select the node contents
      if (range.startContainer && range.collapsed) {
        range.selectNodeContents(range.startContainer);
      }
    }

    const bounding = range.getBoundingClientRect();
    const documentElement = dom.doc.documentElement;

    return (
      bounding.bottom >= 0 &&
      bounding.right >= 0 &&
      bounding.left <=
        (window.innerWidth || documentElement.clientWidth || 0) &&
      bounding.top <= (window.innerHeight || documentElement.clientHeight || 0)
    );
  }

  /**
   * @param {Y.Snapshot} snapshot
   * @param {Y.Snapshot} prevSnapshot
   */
  renderSnapshot(snapshot: Y.Snapshot, prevSnapshot: Y.Snapshot) {
    if (!prevSnapshot) {
      prevSnapshot = Y.createSnapshot(Y.createDeleteSet(), new Map());
    }
    this.prosemirrorView!.dispatch(
      this._tr.setMeta(ySyncPluginKey, {prevSnapshot, snapshot}),
    );
  }

  unrenderSnapshot() {
    this.mapping.clear();
    this.mux(() => {
      const fragmentContent = this.type
        .toArray()
        .map((t) =>
          $createNodeFromYElement(
            t as Y.XmlElement,
            this,
          ),
        )
        .filter((n) => n !== null);
      // @ts-ignore
      const tr = this._tr.replace(
        0,
        this.prosemirrorView!.state.doc.content.size,
        new PModel.Slice(PModel.Fragment.from(fragmentContent), 0, 0),
      );
      tr.setMeta(ySyncPluginKey, {prevSnapshot: null, snapshot: null});
      this.prosemirrorView!.dispatch(tr);
    });
  }

  _forceRerender() {
    this.mapping.clear();
    this.mux(() => {
      // If this is a forced rerender, this might neither happen as a pm change nor within a Yjs
      // transaction. Then the "before selection" doesn't exist. In this case, we need to create a
      // relative position before replacing content. Fixes #126
      const sel =
        this.beforeTransactionSelection !== null
          ? null
          : this.prosemirrorView!.state.selection;
      const fragmentContent = this.type
        .toArray()
        .map((t) =>
          $createNodeFromYElement(
            t as Y.XmlElement,
            this,
          ),
        )
        .filter((n) => n !== null);
      // @ts-ignore
      const tr = this._tr.replace(
        0,
        this.prosemirrorView!.state.doc.content.size,
        new PModel.Slice(PModel.Fragment.from(fragmentContent), 0, 0),
      );
      if (sel) {
        /**
         * If the Prosemirror document we just created from this.type is
         * smaller than the previous document, the selection might be
         * out of bound, which would make Prosemirror throw an error.
         */
        const clampedAnchor = math.min(
          math.max(sel.anchor, 0),
          tr.doc.content.size,
        );
        const clampedHead = math.min(
          math.max(sel.head, 0),
          tr.doc.content.size,
        );

        tr.setSelection(
          TextSelection.create(tr.doc, clampedAnchor, clampedHead),
        );
      }
      this.prosemirrorView!.dispatch(
        tr.setMeta(ySyncPluginKey, {binding: this, isChangeOrigin: true}),
      );
    });
  }

  _renderSnapshot(
    snapshot: Y.Snapshot | Uint8Array,
    prevSnapshot: Y.Snapshot | Uint8Array,
    pluginState: any,
  ) {
    /**
     * The document that contains the full history of this document.
     */
    let historyDoc: Y.Doc = this.doc;
    if (!snapshot) {
      snapshot = Y.snapshot(this.doc);
    }
    if (snapshot instanceof Uint8Array || prevSnapshot instanceof Uint8Array) {
      if (
        !(snapshot instanceof Uint8Array) ||
        !(prevSnapshot instanceof Uint8Array)
      ) {
        // expected both snapshots to be v2 updates
        error.unexpectedCase();
      }
      historyDoc = new Y.Doc({gc: false});
      Y.applyUpdateV2(historyDoc, prevSnapshot);
      prevSnapshot = Y.snapshot(historyDoc);
      Y.applyUpdateV2(historyDoc, snapshot);
      snapshot = Y.snapshot(historyDoc);
    }
    // clear mapping because we are going to rerender
    this.mapping.clear();
    this.mux(() => {
      historyDoc.transact((transaction) => {
        // before rendering, we are going to sanitize ops and split deleted ops
        // if they were deleted by seperate users.
        /**
         * @type {Y.PermanentUserData}
         */
        const pud = pluginState.permanentUserData;
        if (pud) {
          pud.dss.forEach((ds) => {
            Y.iterateDeletedStructs(transaction, ds, (_item) => {});
          });
        }
        /**
         * @param {'removed'|'added'} type
         * @param {Y.ID} id
         */
        const computeYChange = (type, id) => {
          const user =
            type === 'added'
              ? pud.getUserByClientId(id.client)
              : pud.getUserByDeletedId(id);
          return {
            color: getUserColor(
              pluginState.colorMapping,
              pluginState.colors,
              user,
            ),
            type,
            user,
          };
        };
        // Create document fragment and render
        const fragmentContent = Y.typeListToArraySnapshot(
          this.type, // @todo this should use historyDoc's type instead
          new Y.Snapshot(prevSnapshot.ds, snapshot.sv),
        )
          .map((t) => {
            if (
              !t._item.deleted ||
              isVisible(t._item, snapshot) ||
              isVisible(t._item, prevSnapshot)
            ) {
              return $createNodeFromYElement(
                t,
                {mapping: new Map()},
                snapshot,
                prevSnapshot,
                computeYChange,
              );
            } else {
              // No need to render elements that are not visible by either snapshot.
              // If a client adds and deletes content in the same snapshot the element is not visible by either snapshot.
              return null;
            }
          })
          .filter((n) => n !== null);
        // @ts-ignore
        const tr = this._tr.replace(
          0,
          this.prosemirrorView!.state.doc.content.size,
          new PModel.Slice(PModel.Fragment.from(fragmentContent), 0, 0),
        );
        this.prosemirrorView!.dispatch(
          tr.setMeta(ySyncPluginKey, {isChangeOrigin: true}),
        );
      }, ySyncPluginKey);
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _typeChanged(events: Array<Y.YEvent<any>>, transaction: Y.Transaction) {
    if (this.prosemirrorView == null) {
      return;
    }
    const syncState = ySyncPluginKey.getState(this.prosemirrorView.state);
    if (
      events.length === 0 ||
      syncState.snapshot != null ||
      syncState.prevSnapshot != null
    ) {
      // drop out if snapshot is active
      this.renderSnapshot(syncState.snapshot, syncState.prevSnapshot);
      return;
    }
    this.mux(() => {
      const delType = (_value: any, type: Y.AbstractType<any>) =>
        this.mapping.delete(type);
      Y.iterateDeletedStructs(transaction, transaction.deleteSet, (struct) => {
        if (struct.constructor === Y.Item) {
          const content: Y.ContentType = (struct as Y.Item)
            .content as Y.ContentType;
          const type = content.type;
          if (type) {
            this.mapping.delete(type);
          }
        }
      });
      transaction.changed.forEach(delType);
      transaction.changedParentTypes.forEach(delType);
      const fragmentContent = this.type
        .toArray()
        .map((t) =>
          $createNodeIfNotExists(
            t as Y.XmlElement | Y.XmlHook,
            this,
          ),
        )
        .filter((n) => n !== null);
      // @ts-ignore
      let tr = this._tr.replace(
        0,
        this.prosemirrorView!.state.doc.content.size,
        new PModel.Slice(PModel.Fragment.from(fragmentContent), 0, 0),
      );
      restoreRelativeSelection(tr, this.beforeTransactionSelection, this);
      tr = tr.setMeta(ySyncPluginKey, {
        isChangeOrigin: true,
        isUndoRedoOperation: transaction.origin instanceof Y.UndoManager,
      });
      if (
        this.beforeTransactionSelection !== null &&
        this._isLocalCursorInView()
      ) {
        tr.scrollIntoView();
      }
      this.prosemirrorView!.dispatch(tr);
    });
  }

  _prosemirrorChanged(doc: PModel.Node) {
    this.doc.transact(() => {
      updateYFragment(this.doc, this.type, doc, this);
      this.beforeTransactionSelection = getRelativeSelection(
        this,
        this.prosemirrorView!.state,
      );
    }, ySyncPluginKey);
  }

  /**
   * View is ready to listen to changes. Register observers.
   * @param {any} prosemirrorView
   */
  initView(prosemirrorView) {
    if (this.prosemirrorView != null) {
      this.destroy();
    }
    this.prosemirrorView = prosemirrorView;
    this.doc.on('beforeAllTransactions', this.beforeAllTransactions);
    this.doc.on('afterAllTransactions', this.afterAllTransactions);
    this.type.observeDeep(this._observeFunction);
  }

  destroy() {
    if (this.prosemirrorView == null) {
      return;
    }
    this.prosemirrorView = null;
    this.type.unobserveDeep(this._observeFunction);
    this.doc.off('beforeAllTransactions', this.beforeAllTransactions);
    this.doc.off('afterAllTransactions', this.afterAllTransactions);
  }
}

/**
 * @private
 */
export const $createNodeIfNotExists = (
  el: Y.XmlElement | Y.XmlHook,
  meta: Binding,
  snapshot?: Y.Snapshot,
  prevSnapshot?: Y.Snapshot,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  computeYChange?: (event: 'removed' | 'added', id: Y.ID) => any,
): LexicalNode | TextNode[] | null => {
  const node = meta.mapping.get(el);
  if (node === undefined) {
    if (el instanceof Y.XmlElement) {
      return $createNodeFromYElement(
        el,
        meta,
        snapshot,
        prevSnapshot,
        computeYChange,
      );
    } else {
      throw error.methodUnimplemented(); // we are currently not handling hooks
    }
  }
  return node;
};

/**
 * @private
 * @return Returns node if node could be created. Otherwise it deletes the yjs type and returns null
 */
export const $createNodeFromYElement = (
  el: Y.XmlElement,
  meta: Binding,
  snapshot?: Y.Snapshot,
  prevSnapshot?: Y.Snapshot,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  computeYChange?: (event: 'removed' | 'added', id: Y.ID) => any,
): LexicalNode | TextNode[] | null => {
  const children: LexicalNode[] = [];
  /**
   * @param {Y.XmlElement | Y.XmlText} type
   */
  const $createChildren = (type: Y.XmlElement | Y.XmlText | Y.XmlHook) => {
    if (type instanceof Y.XmlElement) {
      const n = $createNodeIfNotExists(
        type,
        meta,
        snapshot,
        prevSnapshot,
        computeYChange,
      );
      if (n !== null) {
        if (n instanceof Array) {
          children.push(...n);
        } else {
          children.push(n);
        }
      }
    } else if (type instanceof Y.XmlText) {
      // If the next ytext exists and was created by us, move the content to the current ytext.
      // This is a fix for #160 -- duplication of characters when two Y.Text exist next to each
      // other.
      // eslint-disable-next-line lexical/no-optional-chaining
      const content = type._item!.right?.content as Y.ContentType | undefined;
      // eslint-disable-next-line lexical/no-optional-chaining
      const nextytext = content?.type;
      if (
        nextytext instanceof Y.Text &&
        !nextytext._item!.deleted &&
        nextytext._item!.id.client === nextytext.doc!.clientID
      ) {
        type.applyDelta([{retain: type.length}, ...nextytext.toDelta()]);
        nextytext.doc!.transact((tr) => {
          nextytext._item!.delete(tr);
        });
      }
      // now create the prosemirror text nodes
      const ns = $createTextNodesFromYText(
        type,
        meta,
        snapshot,
        prevSnapshot,
        computeYChange,
      );
      if (ns !== null) {
        ns.forEach((textchild) => {
          if (textchild !== null) {
            children.push(textchild);
          }
        });
      }
    } else {
      throw error.methodUnimplemented(); // we are currently not handling hooks
    }
  };
  if (snapshot === undefined || prevSnapshot === undefined) {
    el.toArray().forEach($createChildren);
  } else {
    Y.typeListToArraySnapshot(
      el,
      new Y.Snapshot(prevSnapshot.ds, snapshot.sv),
    ).forEach($createChildren);
  }
  try {
    const attrs = el.getAttributes(snapshot);
    if (snapshot !== undefined) {
      if (!isVisible(el._item!, snapshot)) {
        attrs.ychange = computeYChange
          ? computeYChange('removed', el._item!.id)
          : {type: 'removed'};
      } else if (!isVisible(el._item!, prevSnapshot)) {
        attrs.ychange = computeYChange
          ? computeYChange('added', el._item!.id)
          : {type: 'added'};
      }
    }
    const type = attrs.__type;
    const registeredNodes = meta.editor._nodes;
    const nodeInfo = registeredNodes.get(type);
    if (nodeInfo === undefined) {
      throw new Error(`Node ${type} is not registered`);
    }
    const node = new nodeInfo.klass();
    $syncPropertiesFromYjs(meta, el, node, null);
    if (node instanceof ElementNode) {
      node.splice(0, 0, children);
    }
    meta.mapping.set(el, node);
    return node;
  } catch (e) {
    // an error occured while creating the node. This is probably a result of a concurrent action.
    el.doc!.transact((transaction) => {
      el._item!.delete(transaction);
    }, meta);
    meta.mapping.delete(el);
    return null;
  }
};

/**
 * @private
 * @return {Array<TextNode>|null}
 */
const $createTextNodesFromYText = (
  text: Y.XmlText,
  meta: Binding,
  snapshot?: Y.Snapshot,
  prevSnapshot?: Y.Snapshot,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  computeYChange?: (event: 'removed' | 'added', id: Y.ID) => any,
) => {
  const nodes: TextNode[] = [];
  const deltas = text.toDelta(snapshot, prevSnapshot, computeYChange);
  try {
    for (let i = 0; i < deltas.length; i++) {
      const delta = deltas[i];
      const node = $createTextNode(delta.insert);
      $syncPropertiesFromYjs(meta, delta.attributes.__properties, node, null);
      nodes.push(node);
    }
  } catch (e) {
    // an error occured while creating the node. This is probably a result of a concurrent action.
    text.doc!.transact((transaction) => {
      text._item!.delete(transaction);
    });
    return null;
  }
  return nodes;
};

/**
 * @private
 */
const createTypeFromTextNodes = (
  nodes: TextNode[],
  meta: Binding,
): Y.XmlText => {
  const type = new Y.XmlText();
  const delta = nodes.map((node) => ({
    attributes: { __properties: propertiesToAttributes(node, meta) },
    insert: node.getTextContent(),
  }));
  type.applyDelta(delta);
  meta.mapping.set(type, nodes);
  return type;
};

/**
 * @private
 */
const createTypeFromElementNode = (
  node: LexicalNode,
  meta: Binding,
): Y.XmlElement => {
  const type = new Y.XmlElement(node.getType());
  const attrs = propertiesToAttributes(node, meta);
  for (const key in attrs) {
    const val = attrs[key];
    if (val !== null) {
      type.setAttribute(key, val);
    }
  }
  if (!(node instanceof ElementNode)) {
    return type;
  }
  type.insert(
    0,
    normalizePNodeContent(node).map((n) =>
      createTypeFromTextOrElementNode(n, meta),
    ),
  );
  meta.mapping.set(type, node);
  return type;
};

/**
 * @private
 */
const createTypeFromTextOrElementNode = (
  node: LexicalNode | TextNode[],
  meta: Binding,
): Y.XmlElement | Y.XmlText =>
  node instanceof Array
    ? createTypeFromTextNodes(node, meta)
    : createTypeFromElementNode(node, meta);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const isObject = (val: any) => typeof val === 'object' && val !== null;

const equalAttrs = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pattrs: Record<string, any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  yattrs: Record<string, any>,
) => {
  const keys = Object.keys(pattrs).filter((key) => pattrs[key] !== null);
  let eq =
    keys.length ===
    Object.keys(yattrs).filter((key) => yattrs[key] !== null).length;
  for (let i = 0; i < keys.length && eq; i++) {
    const key = keys[i];
    const l = pattrs[key];
    const r = yattrs[key];
    eq =
      key === 'ychange' ||
      l === r ||
      (isObject(l) && isObject(r) && equalAttrs(l, r));
  }
  return eq;
};

type NormalizedPNodeContent = Array<Array<TextNode> | LexicalNode>;

const normalizePNodeContent = (pnode: LexicalNode): NormalizedPNodeContent => {
  if (!(pnode instanceof ElementNode)) {
    return [pnode];
  }
  const c = pnode.getChildren();
  const res: NormalizedPNodeContent = [];
  for (let i = 0; i < c.length; i++) {
    const n = c[i];
    if (n instanceof TextNode) {
      const textNodes: TextNode[] = [];
      for (
        let tnode = c[i];
        i < c.length && tnode instanceof TextNode;
        tnode = c[++i]
      ) {
        textNodes.push(tnode);
      }
      i--;
      res.push(textNodes);
    } else {
      res.push(n);
    }
  }
  return res;
};

const equalYTextLText = (
  ytext: Y.XmlText,
  ltexts: TextNode[],
  meta: Binding,
) => {
  const delta = ytext.toDelta();
  return (
    delta.length === ltexts.length &&
    delta.every(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (d: any, i: number) =>
        d.insert === ltexts[i].getTextContent() &&
        equalAttrs(d.attributes.__properties, propertiesToAttributes(ltexts[i], meta)),
    )
  );
};

const equalYTypePNode = (
  ytype: Y.XmlElement | Y.XmlText | Y.XmlHook,
  pnode: LexicalNode | TextNode[],
  meta: Binding,
): boolean => {
  if (
    ytype instanceof Y.XmlElement &&
    !(pnode instanceof Array) &&
    matchNodeName(ytype, pnode)
  ) {
    const normalizedContent = normalizePNodeContent(pnode);
    return (
      ytype._length === normalizedContent.length &&
      equalAttrs(ytype.getAttributes(), propertiesToAttributes(pnode, meta)) &&
      ytype
        .toArray()
        .every((ychild, i) =>
          equalYTypePNode(ychild, normalizedContent[i], meta),
        )
    );
  }
  return (
    ytype instanceof Y.XmlText &&
    pnode instanceof Array &&
    equalYTextLText(ytype, pnode, meta)
  );
};

const mappedIdentity = (
  mapped: LexicalNode | TextNode[] | undefined,
  pcontent: LexicalNode | TextNode[],
) =>
  mapped === pcontent ||
  (mapped instanceof Array &&
    pcontent instanceof Array &&
    mapped.length === pcontent.length &&
    mapped.every((a, i) => pcontent[i] === a));

type EqualityFactor = {
  foundMappedChild: boolean;
  equalityFactor: number;
};

const computeChildEqualityFactor = (
  ytype: Y.XmlElement,
  pnode: LexicalNode,
  meta: Binding,
  dirtyElements: Set<NodeKey>,
): EqualityFactor => {
  const yChildren = ytype.toArray();
  const pChildren = normalizePNodeContent(pnode);
  const pChildCnt = pChildren.length;
  const yChildCnt = yChildren.length;
  const minCnt = math.min(yChildCnt, pChildCnt);
  let left = 0;
  let right = 0;
  let foundMappedChild = false;
  for (; left < minCnt; left++) {
    const leftY = yChildren[left];
    const leftP = pChildren[left];
    if (mappedIdentity(meta.mapping.get(leftY), leftP)) {
      foundMappedChild = true; // definite (good) match!
    } else if (!equalYTypePNode(leftY, leftP, meta)) {
      break;
    }
  }
  for (; left + right < minCnt; right++) {
    const rightY = yChildren[yChildCnt - right - 1];
    const rightP = pChildren[pChildCnt - right - 1];
    if (mappedIdentity(meta.mapping.get(rightY), rightP)) {
      foundMappedChild = true;
    } else if (!equalYTypePNode(rightY, rightP, meta)) {
      break;
    }
  }
  return {
    equalityFactor: left + right,
    foundMappedChild,
  };
};

/**
 * @param {Y.Text} ytext
 */
const ytextTrans = (
  ytext: Y.Text,
): {nAttrs: Record<string, null>; str: string} => {
  let str = '';
  /**
   * @type {Y.Item|null}
   */
  let n = ytext._start;
  const nAttrs: Record<string, null> = {};
  while (n !== null) {
    if (!n.deleted) {
      if (n.countable && n.content instanceof Y.ContentString) {
        str += n.content.str;
      } else if (n.content instanceof Y.ContentFormat) {
        nAttrs[n.content.key] = null;
      }
    }
    n = n.right;
  }
  return {
    nAttrs,
    str,
  };
};

/**
 * @todo test this more
 */
const updateYText = (
  ytext: Y.Text,
  ltexts: TextNode[],
  meta: Binding,
) => {
  meta.mapping.set(ytext, ltexts);
  const {nAttrs, str} = ytextTrans(ytext);
  const content = ltexts.map((l) => ({
    attributes: Object.assign({}, nAttrs, { __properties: propertiesToAttributes(l, meta) }),
    insert: /** @type {any} */ l.getTextContent(),
  }));
  const {insert, remove, index} = simpleDiff(
    str,
    content.map((c) => c.insert).join(''),
  );
  ytext.delete(index, remove);
  ytext.insert(index, insert);
  ytext.applyDelta(
    content.map((c) => ({attributes: c.attributes, retain: c.insert.length})),
  );
};

const propertiesToAttributes = (node: LexicalNode, meta: Binding) => {
  // syncPropertiesFromLexical
  const type = node.__type;
  const nodeProperties = meta.nodeProperties;
  let properties = nodeProperties.get(type);
  if (properties === undefined) {
    properties = Object.keys(node).filter((property) => {
      return !isExcludedProperty(property, node, meta);
    });
    nodeProperties.set(type, properties);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const attrs: Record<string, any> = {};
  properties.forEach((property) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    attrs[property] = (node as any)[property];
  });
  return attrs;
};

/**
 * Update a yDom node by syncing the current content of the prosemirror node.
 *
 * This is a y-prosemirror internal feature that you can use at your own risk.
 *
 * @private
 * @unstable
 */
export const updateYFragment = (
  y: Y.Doc,
  yDomFragment: Y.XmlElement,
  pNode: LexicalNode,
  meta: Binding,
  dirtyElements: Set<NodeKey>,
) => {
  if (
    yDomFragment instanceof Y.XmlElement &&
    yDomFragment.nodeName !== pNode.getType() &&
    !(yDomFragment.nodeName === 'UNDEFINED' && pNode.getType() === 'root')
  ) {
    throw new Error('node name mismatch!');
  }
  meta.mapping.set(yDomFragment, pNode);
  // update attributes
  if (yDomFragment instanceof Y.XmlElement) {
    const yDomAttrs = yDomFragment.getAttributes();
    const pAttrs = propertiesToAttributes(pNode, meta);
    for (const key in pAttrs) {
      if (pAttrs[key] !== null) {
        if (yDomAttrs[key] !== pAttrs[key] && key !== 'ychange') {
          yDomFragment.setAttribute(key, pAttrs[key]);
        }
      } else {
        yDomFragment.removeAttribute(key);
      }
    }
    // remove all keys that are no longer in pAttrs
    for (const key in yDomAttrs) {
      if (pAttrs[key] === undefined) {
        yDomFragment.removeAttribute(key);
      }
    }
  }
  // update children
  const pChildren = normalizePNodeContent(pNode);
  const pChildCnt = pChildren.length;
  const yChildren = yDomFragment.toArray();
  const yChildCnt = yChildren.length;
  const minCnt = math.min(pChildCnt, yChildCnt);
  let left = 0;
  let right = 0;
  // find number of matching elements from left
  for (; left < minCnt; left++) {
    const leftY = yChildren[left];
    const leftP = pChildren[left];
    if (mappedIdentity(meta.mapping.get(leftY), leftP)) {
      if (leftP instanceof ElementNode && dirtyElements.has(leftP.getKey())) {
        updateYFragment(y, leftY as Y.XmlElement, leftP as LexicalNode, meta, dirtyElements);
      }
    } else {
      if (equalYTypePNode(leftY, leftP, meta)) {
        // update mapping
        meta.mapping.set(leftY, leftP);
      } else {
        break;
      }
    }
  }
  // find number of matching elements from right
  for (; right + left + 1 < minCnt; right++) {
    const rightY = yChildren[yChildCnt - right - 1];
    const rightP = pChildren[pChildCnt - right - 1];
    if (mappedIdentity(meta.mapping.get(rightY), rightP)) {
      if (rightP instanceof ElementNode && dirtyElements.has(rightP.getKey())) {
        updateYFragment(y, rightY as Y.XmlElement, rightP as LexicalNode, meta, dirtyElements);
      }
    } else {
      if (equalYTypePNode(rightY, rightP, meta)) {
        // update mapping
        meta.mapping.set(rightY, rightP);
      } else {
        break;
      }
    }
  }
  y.transact(() => {
    // try to compare and update
    while (yChildCnt - left - right > 0 && pChildCnt - left - right > 0) {
      const leftY = yChildren[left];
      const leftP = pChildren[left];
      const rightY = yChildren[yChildCnt - right - 1];
      const rightP = pChildren[pChildCnt - right - 1];
      if (leftY instanceof Y.XmlText && leftP instanceof Array) {
        if (!equalYTextLText(leftY, leftP, meta)) {
          updateYText(leftY, leftP, meta);
        }
        left += 1;
      } else {
        let updateLeft =
          leftY instanceof Y.XmlElement && matchNodeName(leftY, leftP);
        let updateRight =
          rightY instanceof Y.XmlElement && matchNodeName(rightY, rightP);
        if (updateLeft && updateRight) {
          // decide which which element to update
          const equalityLeft = computeChildEqualityFactor(
            leftY as Y.XmlElement,
            leftP as LexicalNode,
            meta,
            dirtyElements,
          );
          const equalityRight = computeChildEqualityFactor(
            rightY as Y.XmlElement,
            rightP as LexicalNode,
            meta,
            dirtyElements,
          );
          if (
            equalityLeft.foundMappedChild &&
            !equalityRight.foundMappedChild
          ) {
            updateRight = false;
          } else if (
            !equalityLeft.foundMappedChild &&
            equalityRight.foundMappedChild
          ) {
            updateLeft = false;
          } else if (
            equalityLeft.equalityFactor < equalityRight.equalityFactor
          ) {
            updateLeft = false;
          } else {
            updateRight = false;
          }
        }
        if (updateLeft) {
          updateYFragment(y, leftY as Y.XmlElement, leftP as LexicalNode, meta, dirtyElements);
          left += 1;
        } else if (updateRight) {
          updateYFragment(
            y,
            rightY as Y.XmlElement,
            rightP as LexicalNode,
            meta,
            dirtyElements,
          );
          right += 1;
        } else {
          meta.mapping.delete(yDomFragment.get(left));
          yDomFragment.delete(left, 1);
          yDomFragment.insert(left, [
            createTypeFromTextOrElementNode(leftP, meta),
          ]);
          left += 1;
        }
      }
    }
    const yDelLen = yChildCnt - left - right;
    if (
      yChildCnt === 1 &&
      pChildCnt === 0 &&
      yChildren[0] instanceof Y.XmlText
    ) {
      meta.mapping.delete(yChildren[0]);
      // Edge case handling https://github.com/yjs/y-prosemirror/issues/108
      // Only delete the content of the Y.Text to retain remote changes on the same Y.Text object
      yChildren[0].delete(0, yChildren[0].length);
    } else if (yDelLen > 0) {
      yDomFragment
        .slice(left, left + yDelLen)
        .forEach((type) => meta.mapping.delete(type));
      yDomFragment.delete(left, yDelLen);
    }
    if (left + right < pChildCnt) {
      const ins = [];
      for (let i = left; i < pChildCnt - right; i++) {
        ins.push(createTypeFromTextOrElementNode(pChildren[i], meta));
      }
      yDomFragment.insert(left, ins);
    }
  }, meta);
};

const matchNodeName = (
  yElement: Y.XmlElement,
  pNode: LexicalNode | TextNode[],
) => !(pNode instanceof Array) && yElement.nodeName === pNode.getType();

// lib.js

/**
 * Transforms a Prosemirror based absolute position to a Yjs Cursor (relative position in the Yjs model).
 *
 * @param {number} pos
 * @param {Y.XmlFragment} type
 * @param {LexicalMapping} mapping
 * @return {any} relative position
 */
export const absolutePositionToRelativePosition = (pos, type, mapping) => {
  if (pos === 0) {
    return Y.createRelativePositionFromTypeIndex(type, 0, -1);
  }
  /**
   * @type {any}
   */
  let n =
    type._first === null
      ? null
      : /** @type {Y.ContentType} */ type._first.content.type;
  while (n !== null && type !== n) {
    if (n instanceof Y.XmlText) {
      if (n._length >= pos) {
        return Y.createRelativePositionFromTypeIndex(n, pos, -1);
      } else {
        pos -= n._length;
      }
      if (n._item !== null && n._item.next !== null) {
        n = /** @type {Y.ContentType} */ n._item.next.content.type;
      } else {
        do {
          n = n._item === null ? null : n._item.parent;
          pos--;
        } while (
          n !== type &&
          n !== null &&
          n._item !== null &&
          n._item.next === null
        );
        if (n !== null && n !== type) {
          // @ts-gnore we know that n.next !== null because of above loop conditition
          n =
            n._item === null
              ? null
              : /** @type {Y.ContentType} */ /** @type Y.Item */ n._item.next
                  .content.type;
        }
      }
    } else {
      const pNodeSize = /** @type {any} */ (mapping.get(n) || {nodeSize: 0})
        .nodeSize;
      if (n._first !== null && pos < pNodeSize) {
        n = /** @type {Y.ContentType} */ n._first.content.type;
        pos--;
      } else {
        if (pos === 1 && n._length === 0 && pNodeSize > 1) {
          // edge case, should end in this paragraph
          return new Y.RelativePosition(
            n._item === null ? null : n._item.id,
            n._item === null ? Y.findRootTypeKey(n) : null,
            null,
          );
        }
        pos -= pNodeSize;
        if (n._item !== null && n._item.next !== null) {
          n = /** @type {Y.ContentType} */ n._item.next.content.type;
        } else {
          if (pos === 0) {
            // set to end of n.parent
            n = n._item === null ? n : n._item.parent;
            return new Y.RelativePosition(
              n._item === null ? null : n._item.id,
              n._item === null ? Y.findRootTypeKey(n) : null,
              null,
            );
          }
          do {
            n = /** @type {Y.Item} */ n._item.parent;
            pos--;
          } while (n !== type && /** @type {Y.Item} */ n._item.next === null);
          // if n is null at this point, we have an unexpected case
          if (n !== type) {
            // We know that n._item.next is defined because of above loop condition
            n =
              /** @type {Y.ContentType} */ /** @type {Y.Item} */ /** @type {Y.Item} */ n
                ._item.next.content.type;
          }
        }
      }
    }
    if (n === null) {
      throw error.unexpectedCase();
    }
    if (pos === 0 && n.constructor !== Y.XmlText && n !== type) {
      // TODO: set to <= 0
      return createRelativePosition(n._item.parent, n._item);
    }
  }
  return Y.createRelativePositionFromTypeIndex(type, type._length, -1);
};

const createRelativePosition = (type, item) => {
  let typeid = null;
  let tname = null;
  if (type._item === null) {
    tname = Y.findRootTypeKey(type);
  } else {
    typeid = Y.createID(type._item.id.client, type._item.id.clock);
  }
  return new Y.RelativePosition(typeid, tname, item.id);
};

/**
 * @param {Y.Doc} y
 * @param {Y.XmlFragment} documentType Top level type that is bound to pView
 * @param {any} relPos Encoded Yjs based relative position
 * @param {LexicalMapping} mapping
 * @return {null|number}
 */
export const relativePositionToAbsolutePosition = (
  y: Y.Doc,
  documentType: Y.XmlElement,
  relPos: any,
  mapping: LexicalMapping,
) => {
  const decodedPos = Y.createAbsolutePositionFromRelativePosition(relPos, y);
  if (
    decodedPos === null ||
    (decodedPos.type !== documentType &&
      !Y.isParentOf(documentType, decodedPos.type._item))
  ) {
    return null;
  }
  let type = decodedPos.type;
  let pos = 0;
  if (type.constructor === Y.XmlText) {
    pos = decodedPos.index;
  } else if (type._item === null || !type._item.deleted) {
    let n = type._first;
    let i = 0;
    while (i < type._length && i < decodedPos.index && n !== null) {
      if (!n.deleted) {
        const t = (n.content as Y.ContentType).type;
        i++;
        if (t instanceof Y.XmlText) {
          pos += t._length;
        } else {
          pos += (mapping.get(t) as any).nodeSize;
        }
      }
      n = n.right as Y.Item;
    }
    pos += 1; // increase because we go out of n
  }
  while (type !== documentType && type._item !== null) {
    // @ts-ignore
    const parent = type._item.parent;
    // @ts-ignore
    if (parent._item === null || !parent._item.deleted) {
      pos += 1; // the start tag
      let n = /** @type {Y.AbstractType} */ parent._first;
      // now iterate until we found type
      while (n !== null) {
        const contentType = /** @type {Y.ContentType} */ n.content.type;
        if (contentType === type) {
          break;
        }
        if (!n.deleted) {
          if (contentType instanceof Y.XmlText) {
            pos += contentType._length;
          } else {
            pos += /** @type {any} */ mapping.get(contentType).nodeSize;
          }
        }
        n = n.right;
      }
    }
    type = /** @type {Y.AbstractType} */ parent;
  }
  return pos - 1; // we don't count the most outer tag, because it is a fragment
};

// utils.js

/**
 * Custom function to transform sha256 hash to N byte
 */
const _convolute = (digest: Uint8Array) => {
  const N = 6;
  for (let i = N; i < digest.length; i++) {
    digest[i % N] = digest[i % N] ^ digest[i];
  }
  return digest.slice(0, N);
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const hashOfJSON = (json: any) =>
  buf.toBase64(_convolute(sha256.digest(buf.encodeAny(json))));
