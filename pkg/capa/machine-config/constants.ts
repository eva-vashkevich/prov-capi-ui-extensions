export const HTTP_TOKENS_VALUES = {
  REQUIRED: 'required',
  OPTIONAL: 'optional',
} as const;

export const SECURITY_GROUP_ROLES = [
  'node',
  'controlplane',
  'apiserver-lb',
  'lb'
] as const;
