/**
 * Types de la base utilisés par le code : ceux générés depuis les migrations
 * (generated/database.ts), affinés là où une contrainte CHECK porte un sens métier
 * que l'introspection ne voit pas.
 *
 * La concordance entre ces types et les contraintes SQL est vérifiée par les tests
 * (schema.test.ts).
 */
import type { PostStatus } from '@posts-auto/core';
import type { ColumnType } from 'kysely';
import type {
  DB as GeneratedDB,
  PostStatusHistory as GeneratedPostStatusHistory,
  PostVersions as GeneratedPostVersions,
  Posts as GeneratedPosts,
} from './generated/database.js';

export interface Posts extends Omit<GeneratedPosts, 'status'> {
  status: ColumnType<PostStatus, PostStatus | undefined, PostStatus>;
}

export interface PostVersions extends Omit<GeneratedPostVersions, 'has_blocking_markers'> {
  /** Colonne calculée par la base (VAL-03) : jamais écrite par l'application. */
  has_blocking_markers: ColumnType<boolean, never, never>;
}

export interface PostStatusHistory extends Omit<GeneratedPostStatusHistory, 'from_status' | 'to_status'> {
  from_status: PostStatus | null;
  to_status: PostStatus;
}

export interface DB extends Omit<GeneratedDB, 'posts' | 'post_versions' | 'post_status_history'> {
  posts: Posts;
  post_versions: PostVersions;
  post_status_history: PostStatusHistory;
}
