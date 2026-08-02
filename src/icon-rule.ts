import { scopeMatchTarget, type LinkScope } from "./url-scope";

const RULE_ELEMENTS = [
  [".protyle-wysiwyg span[data-type~='a']", "data-href"],
  [".protyle-wysiwyg span[data-type~='url']", "data-href"],
  [".protyle-wysiwyg a", "href"],
  [".b3-typography a", "href"],
] as const;

export function createIconRule(scope: LinkScope, iconUrl: string, iconSize: number) {
  const selectors: string[] = [];
  for (const protocol of ["https", "http"] as const) {
    const match = scopeMatchTarget(scope, protocol);
    for (const [element, attribute] of RULE_ELEMENTS) {
      selectors.push(`${element}[${attribute}=${cssString(match.exact)}]::before`);
      for (const boundary of match.boundaries) {
        selectors.push(`${element}[${attribute}^=${cssString(match.exact + boundary)}]::before`);
      }
    }
  }
  return `${selectors.join(",\n")} {
      content: "";
      display: inline-block;
      width: ${iconSize}em;
      height: ${iconSize}em;
      margin-right: 0.22em;
      vertical-align: -0.12em;
      background-image: url(${cssString(iconUrl)});
      background-position: center;
      background-size: contain;
      background-repeat: no-repeat;
    }`;
}

function cssString(value: string) {
  return JSON.stringify(value).replace(/</g, "\\3c ");
}
