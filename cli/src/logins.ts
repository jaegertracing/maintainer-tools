export function sameLogin(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export function hasLogin(logins: Set<string>, login: string): boolean {
  for (const configured of logins) {
    if (sameLogin(configured, login)) return true;
  }
  return false;
}
