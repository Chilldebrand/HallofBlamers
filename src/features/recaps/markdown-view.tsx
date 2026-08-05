import type { ReactNode } from "react";
import { parseInlineMarkdown, parseMarkdownBlocks } from "./markdown";

/**
 * Renders recap markdown as safe JSX — every string in `markdown` reaches the DOM only as a React
 * text node (never `dangerouslySetInnerHTML`), so a draft can never inject real HTML/script
 * regardless of what it contains. This is the ONLY place recap markdown gets turned into markup,
 * used by both the admin preview and the public recap pages.
 */
export function RecapMarkdownView({ markdown, className }: { markdown: string; className?: string }) {
  const blocks = parseMarkdownBlocks(markdown);

  return (
    <div className={className}>
      {blocks.map((block, i) => {
        if (block.type === "heading") {
          const Tag = block.level === 1 ? "h1" : block.level === 2 ? "h2" : "h3";
          const sizeClass = block.level === 1 ? "display text-2xl text-ink sm:text-3xl" : block.level === 2 ? "display text-lg text-ink" : "display text-sm tracking-wide text-muted";
          return (
            <Tag key={i} className={`${sizeClass} mt-6 first:mt-0`}>
              <InlineMarkdown segments={parseInlineMarkdown(block.text)} />
            </Tag>
          );
        }
        if (block.type === "list") {
          return (
            <ul key={i} className="mt-2 flex list-disc flex-col gap-1 pl-5 text-sm text-ink">
              {block.items.map((item, j) => (
                <li key={j}>
                  <InlineMarkdown segments={parseInlineMarkdown(item)} />
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i} className="mt-3 text-sm leading-relaxed text-ink first:mt-0">
            <InlineMarkdown segments={parseInlineMarkdown(block.text)} />
          </p>
        );
      })}
    </div>
  );
}

function InlineMarkdown({ segments }: { segments: ReturnType<typeof parseInlineMarkdown> }) {
  return (
    <>
      {segments.map((seg, i) => {
        let node: ReactNode = seg.text;
        if (seg.bold) node = <strong key="b">{node}</strong>;
        if (seg.italic) node = <em key="i">{node}</em>;
        return <span key={i}>{node}</span>;
      })}
    </>
  );
}
