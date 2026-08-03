export default {
  title: 'Persistent memory',
  description:
    'Durable notes the agent remembers across sessions. User memories are global; workspace and project memories are scoped to this project.',
  add: 'Add memory',
  edit: 'Edit memory',
  editAction: 'Edit',
  forget: 'Forget',
  save: 'Save',
  cancel: 'Cancel',
  loading: 'Loading memories…',
  empty: 'No memories yet.',
  unavailable: 'Persistent memory is only available on the v2 backend.',
  noWorkspace: 'Select a workspace to view its memories.',
  confirmForget: 'Forget the memory "{name}"? This cannot be undone.',
  scopes: {
    user: 'User (global)',
    workspace: 'Workspace',
    project: 'Project',
  },
  types: {
    user: 'User',
    feedback: 'Feedback',
    project: 'Project',
    reference: 'Reference',
  },
  fields: {
    scope: 'Scope',
    type: 'Type',
    name: 'Name',
    namePlaceholder: 'Short label',
    descriptionField: 'Description',
    descriptionPlaceholder: 'When is this memory relevant?',
    body: 'Content',
    bodyPlaceholder: 'The durable content to remember',
  },
  errors: {
    disabled:
      'Persistent memory is disabled. Enable the "persistent-memory" experiment in config to manage memories.',
    trustRequired: 'Project memories require a trusted workspace.',
    generic: 'Something went wrong. Please try again.',
  },
};
