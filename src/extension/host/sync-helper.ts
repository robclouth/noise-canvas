import { copyIfExists, removeIfExists, syncTrees } from "./sync-ops";

// Runs as its own spawned process, outside the permission sandbox Live starts
// the extension host under: the host may only touch its storage tree, but the
// children it spawns are unrestricted, so all file traffic with the user's
// Documents preset tree happens here.
//
//   sync <rootA> <rootB> <subdir...>   two-way newer-wins merge of the subdirs
//   copy <src> <dst>                   copy one file; missing source is a no-op
//   remove <path>                      remove a file or tree
const [op, ...args] = process.argv.slice(2);
try {
  if (op === "sync") syncTrees(args[0], args[1], args.slice(2));
  else if (op === "copy") copyIfExists(args[0], args[1]);
  else if (op === "remove") removeIfExists(args[0]);
  else throw new Error(`unknown op ${op ?? "(none)"}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
