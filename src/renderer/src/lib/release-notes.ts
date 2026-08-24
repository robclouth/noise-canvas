/**
 * Drops the download table a release body opens with, leaving only the notes
 * below it. The table is built for the releases page, where the reader is
 * choosing a file to download, and means nothing inside the updater.
 *
 * The body separates the two with a horizontal rule, so anything up to the
 * first rule goes when a table sits in front of it.
 */
export function stripDownloadTable(html: string): string {
  const rule = /<hr\s*\/?>/i.exec(html);
  if (!rule) return html;
  if (!/<table[\s>]/i.test(html.slice(0, rule.index))) return html;
  return html.slice(rule.index + rule[0].length).trim();
}
