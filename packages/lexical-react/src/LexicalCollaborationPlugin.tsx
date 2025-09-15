/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {JSX} from 'react';

import {useCollaborationContext} from '@lexical/react/LexicalCollaborationContext';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {ExcludedProperties, SyncCursorPositionsFn} from '@lexical/yjs';
import {useEffect} from 'react';

import {InitialEditorStateType} from './LexicalComposer';
import {
  CursorsContainerRef,
  ProviderFactory,
  useYjsCollaboration,
  useYjsCursors,
  useYjsFocusTracking,
  useYjsHistory,
} from './shared/useYjsCollaboration';

const EMPTY_MAP = new Map();

type Props = {
  id: string;
  providerFactory: ProviderFactory;
  shouldBootstrap: boolean;
  username?: string;
  cursorColor?: string;
  cursorsContainerRef?: CursorsContainerRef;
  initialEditorState?: InitialEditorStateType;
  excludedProperties?: ExcludedProperties;
  // `awarenessData` parameter allows arbitrary data to be added to the awareness.
  awarenessData?: object;
  syncCursorPositionsFn?: SyncCursorPositionsFn;
};

export function CollaborationPlugin({
  id,
  providerFactory,
  shouldBootstrap,
  username,
  cursorColor,
  cursorsContainerRef,
  initialEditorState,
  excludedProperties,
  awarenessData,
  syncCursorPositionsFn,
}: Props): JSX.Element {
  const collabContext = useCollaborationContext(username, cursorColor);
  const {yjsDocMap, name, color} = collabContext;

  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    collabContext.isCollabActive = true;

    return () => {
      // Resetting flag only when unmount top level editor collab plugin. Nested
      // editors (e.g. image caption) should unmount without affecting it
      if (editor._parentEditor == null) {
        collabContext.isCollabActive = false;
      }
    };
  }, [collabContext, editor]);

  const {binding, provider} = useYjsCollaboration(
    editor,
    id,
    providerFactory,
    yjsDocMap,
    excludedProperties || EMPTY_MAP,
    name,
    color,
    shouldBootstrap,
    initialEditorState,
    awarenessData,
    syncCursorPositionsFn,
  );

  collabContext.clientID = binding.clientID;

  useYjsHistory(editor, binding);
  useYjsFocusTracking(editor, provider, name, color, awarenessData);
  return useYjsCursors(binding, cursorsContainerRef);
}
