/**
 * The 30 subdomain names every working root gets, in the order they are
 * handed out (Илья's sheet order). A root's free slots are these minus the
 * ones already in Keitaro or banned.
 */
export const SUB_NAMES = [
  'telemedicine', 'medical', 'official', 'therapy', 'mobile', 'doctor', 'expert', 'news', 'meta', 'fb',
  'supplements', 'webmedicine', 'onlineexpert', 'research', 'wellness', 'patient', 'health', 'global', 'blog', 'life',
  'prevention', 'polyclinic', 'immunity', 'browser', 'hospital', 'herbal', 'truth', 'mode', 'sale', 'web',
] as const;

/** The registrable part of a host: the last two labels (every TLD in use is single-label). */
export function rootOf(host: string): string {
  return host.toLowerCase().split('.').slice(-2).join('.');
}
