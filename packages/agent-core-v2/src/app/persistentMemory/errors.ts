/**
 * `persistentMemory` domain error codes.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const MemoryErrors = {
  codes: {
    MEMORY_INVALID_ID: 'memory.invalid_id',
    MEMORY_INVALID_SCOPE: 'memory.invalid_scope',
    MEMORY_INVALID_RECORD: 'memory.invalid_record',
    MEMORY_BODY_TOO_LARGE: 'memory.body_too_large',
    MEMORY_SCOPE_FULL: 'memory.scope_full',
    MEMORY_VERSION_CONFLICT: 'memory.version_conflict',
    MEMORY_TRUST_REQUIRED: 'memory.trust_required',
    MEMORY_NOT_FOUND: 'memory.not_found',
    MEMORY_MUTATION_DENIED: 'memory.mutation_denied',
    MEMORY_CONTENT_REJECTED: 'memory.content_rejected',
  },
  info: {
    'memory.invalid_id': {
      title: 'Invalid memory id',
      retryable: false,
      public: true,
      action: 'Memory ids must be ULIDs; regenerate the id.',
    },
    'memory.invalid_scope': {
      title: 'Invalid memory scope',
      retryable: false,
      public: true,
      action: 'Memory scope must be `user`, `workspace/<id>`, or `project/<id>`.',
    },
    'memory.invalid_record': {
      title: 'Invalid memory record',
      retryable: false,
      public: true,
      action: 'The memory record failed schema validation; check its fields.',
    },
    'memory.body_too_large': {
      title: 'Memory body exceeds the byte cap',
      retryable: false,
      public: true,
      action: 'Shorten the memory body below the configured cap.',
    },
    'memory.scope_full': {
      title: 'Memory scope is at capacity',
      retryable: false,
      public: true,
      action: 'Forget an existing memory before creating a new one in this scope.',
    },
    'memory.version_conflict': {
      title: 'Memory version conflict',
      retryable: false,
      public: true,
      action: 'Reload the memory and retry the update against the current version.',
    },
    'memory.trust_required': {
      title: 'Workspace trust required',
      retryable: false,
      public: true,
      action: 'Trust the workspace before creating or updating project memory.',
    },
    'memory.not_found': {
      title: 'Memory not found',
      retryable: false,
      public: true,
    },
    'memory.mutation_denied': {
      title: 'Memory mutation denied',
      retryable: false,
      public: true,
    },
    'memory.content_rejected': {
      title: 'Memory content rejected',
      retryable: false,
      public: true,
      action: 'Remove credential-like content before persisting memory.',
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(MemoryErrors);

export type MemoryErrorCode = (typeof MemoryErrors.codes)[keyof typeof MemoryErrors.codes];
