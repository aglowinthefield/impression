// Writes each changeset as it was written, one bullet per line, without the commit
// hash the default adds: pi and the CLI show these bullets to people after an update.
export default {
  getReleaseLine: async ({ summary }) =>
    summary
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => (line.startsWith("- ") ? line : `- ${line}`))
      .join("\n"),
  getDependencyReleaseLine: async () => "",
};
