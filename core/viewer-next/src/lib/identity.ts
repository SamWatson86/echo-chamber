export function buildIdentity(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'viewer';

  const random = Math.random().toString(36).slice(2, 8);
  return `${slug}-${random}`;
}
