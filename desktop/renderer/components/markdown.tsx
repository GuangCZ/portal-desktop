import { useMemo } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";

export function sanitizeMarkdown(content: string) {
  const body = DOMPurify.sanitize(marked.parse(content, { async: false }), {
    RETURN_DOM: true,
    ALLOWED_TAGS: [
      "p",
      "br",
      "strong",
      "em",
      "code",
      "pre",
      "blockquote",
      "ul",
      "ol",
      "li",
      "h1",
      "h2",
      "h3",
      "h4",
      "hr",
      "a",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "del",
    ],
    ALLOWED_ATTR: ["href", "title"],
  }) as HTMLElement;
  for (const link of body.querySelectorAll("a")) {
    if (!/^https?:\/\//i.test(link.getAttribute("href") || ""))
      link.removeAttribute("href");
    else {
      link.target = "_blank";
      link.rel = "noreferrer noopener";
    }
  }
  return { html: body.innerHTML, text: body.textContent || content };
}
export function Markdown({
  content,
  className = "reading-text",
}: {
  content: string;
  className?: string;
}) {
  const { html } = useMemo(() => sanitizeMarkdown(content), [content]);
  return (
    <div className={className} dangerouslySetInnerHTML={{ __html: html }} />
  );
}
