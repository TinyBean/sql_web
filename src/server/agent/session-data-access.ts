import path from "node:path";

function within(root: string, filename: string): boolean {
  const relative = path.relative(root, filename);
  return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

/** The same policy is used by the parent, its investigators and anonymous completions. */
export function sessionDataReadPolicy(options: {
  cwd: string; artifactDir: string; sessionId: string; defaultDashboardPath?: string;
}): (filename: string) => boolean {
  const data = path.resolve(options.cwd, ".data");
  const artifacts = path.resolve(options.artifactDir, options.sessionId);
  const dashboard = path.resolve(options.defaultDashboardPath ?? path.join(data, "default-dashboard.json"));
  return (filename) => filename === dashboard || within(artifacts, filename) ||
    within(path.join(data, "daily-analysis"), filename) ||
    (path.dirname(filename) === path.join(data, "logs") && /^oee-daily-\d{4}-\d{2}-\d{2}\.log$/u.test(path.basename(filename)));
}
