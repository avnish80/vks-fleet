/** Does a link go anywhere from this page? A link to the same page with no section or query does nothing. */
export function leadsSomewhere(path: string, currentPathname: string): boolean {
  const [pathname] = path.split(/[?#]/);
  return pathname !== currentPathname || /[?#]/.test(path);
}
