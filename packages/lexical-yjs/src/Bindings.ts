/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {CollabDecoratorNode} from './CollabDecoratorNode';
import type {CollabElementNode} from './CollabElementNode';
import type {CollabLineBreakNode} from './CollabLineBreakNode';
import type {CollabTextNode} from './CollabTextNode';
import type {Cursor} from './SyncCursors';
import type {LexicalEditor, NodeKey, TextNode} from 'lexical';
import type {AbstractType as YAbstractType,Doc} from 'yjs';

import {Klass, LexicalNode} from 'lexical';
import invariant from 'shared/invariant';
import {XmlElement, XmlText} from 'yjs';

import {Provider} from '.';
import {$createCollabElementNode} from './CollabElementNode';

export type ClientID = number;
export type Binding = {
  clientID: number;
  collabNodeMap: Map<
    NodeKey,
    | CollabElementNode
    | CollabTextNode
    | CollabDecoratorNode
    | CollabLineBreakNode
  >;
  mapping: LexicalMapping; // from y-prosemirror.js
  cursors: Map<ClientID, Cursor>;
  cursorsContainer: null | HTMLElement;
  doc: Doc;
  docMap: Map<string, Doc>;
  editor: LexicalEditor;
  id: string;
  nodeProperties: Map<string, Array<string>>;
  root: CollabElementNode;
  rootV2XmlElement: XmlElement;
  useV2: boolean;
  excludedProperties: ExcludedProperties;
};

export type ExcludedProperties = Map<Klass<LexicalNode>, Set<string>>;

/**
 * Either a non-TextNode if type is YXmlElement or an Array of text nodes if YXmlText
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LexicalMapping = Map<YAbstractType<any>, LexicalNode | Array<TextNode>>;

export function createBinding(
  editor: LexicalEditor,
  provider: Provider,
  id: string,
  doc: Doc | null | undefined,
  docMap: Map<string, Doc>,
  excludedProperties: ExcludedProperties = new Map(),
  // DO NOT MERGE THIS WITH USE V2 SET TO TRUE
  useV2: boolean = true,
): Binding {
  invariant(
    doc !== undefined && doc !== null,
    'createBinding: doc is null or undefined',
  );
  const rootXmlText = doc.get('root', XmlText) as XmlText;
  const root: CollabElementNode = $createCollabElementNode(
    rootXmlText,
    null,
    'root',
  );
  root._key = 'root';
  const rootV2XmlElement = doc.get('root.v2', XmlElement) as XmlElement;
  return {
    clientID: doc.clientID,
    collabNodeMap: new Map(),
    cursors: new Map(),
    cursorsContainer: null,
    doc,
    docMap,
    editor,
    excludedProperties,
    id,
    mapping: new Map(),
    nodeProperties: new Map(),
    root,
    rootV2XmlElement,
    useV2,
  };
}
