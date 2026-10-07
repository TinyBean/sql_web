/** Display inventory from OEE_Agent需求及逻辑v4; it does not change MT/ST classification. */
export const MACHINE_PLATFORM_VERSION = "oee-v4";
const inventory = {
  T5773: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 14, 15, 16, 17, 18, 19, 20, 21, 22,
    23, 24, 25, 26, 27, 28, 31, 32, 33, 34, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52,
    55, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 84, 85, 86,
    88, 89, 91, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 158, 165, 166],
  T5831: [35, 36, 37, 38, 39, 40, 53, 97, 98, 112, 113, 114, 115, 116, 117, 118, 119,
    120, 121, 122, 123, 124, 125, 126, 127, 128, 129, 131, 132, 135, 136, 137, 138, 139,
    140, 141, 142, 143, 144, 145, 146, 150, 176, 177, 178, 181, 182, 183, 184, 201, 202, 203, 204],
  T5851: [92, 93, 147, 148, 149, 153, 155, 162, 168, 169, 170, 171, 172, 173, 174, 175,
    179, 180, 185, 186, 187, 188, 189, 190, 191, 192, 193, 194, 195, 196, 197, 198, 199, 200, 205],
} as const;

export const MACHINE_PLATFORMS: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(
  Object.entries(inventory).flatMap(([platform, ids]) => ids.map((id) => ["ADH" + String(id).padStart(3, "0"), platform])),
));

export function machinePlatform(machine: string): string | null {
  return Object.hasOwn(MACHINE_PLATFORMS, machine) ? MACHINE_PLATFORMS[machine]! : null;
}

export function machineLabel(machine: string): string {
  return (machinePlatform(machine) ?? "平台待维护") + "/" + machine;
}

/** Normalize prose and standalone identifier spans; preserve SQL/code and link destinations. */
export function formatMachineMentions(text: string, additionalMachines: readonly string[] = []): string {
  const escaped = [...new Set(additionalMachines)].filter(Boolean).sort((a, b) => b.length - a.length)
    .map((machine) => machine.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  const ids = [...escaped, "(?:ADH|TSPH)\\d{3}"].join("|");
  const pattern = new RegExp("(?<![A-Za-z0-9_])(?:(?:[A-Za-z][A-Za-z0-9_.-]*|平台待维护)/)?(" + ids + ")(?![A-Za-z0-9_])", "gu");
  const singleId = new RegExp("^(?:(?:[A-Za-z][A-Za-z0-9_.-]*|平台待维护)/)?(" + ids + ")$", "u");
  return text.split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`|\]\([^\n)]*\)|https?:\/\/[^\s]+)/gu)
    .map((part, index) => {
      if (index % 2) {
        const match = part.startsWith("`") && part.endsWith("`") ? singleId.exec(part.slice(1, -1)) : null;
        return match ? "`" + machineLabel(match[1]!) + "`" : part;
      }
      return part.replace(pattern, (_match, machine: string) => machineLabel(machine));
    }).join("");
}

export function hasMachineDistributionClaim(text: string): boolean {
  return /(?:机台|ADH\d{3}|TSPH\d{3}).{0,35}(?:集中|分散|很多|较多|少数|多台)|(?:集中|分散|很多|较多|少数|多台).{0,35}(?:机台|ADH\d{3}|TSPH\d{3})/iu.test(text);
}
