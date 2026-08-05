import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { memo, type ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import "highlight.js/styles/github-dark-dimmed.css";

export interface MarkdownRendererProps {
  children: string;
  streaming?: boolean;
}

const languages = {
  bash,
  css,
  diff,
  javascript,
  json,
  markdown,
  python,
  rust,
  typescript,
  xml,
  yaml,
};
for (const [name, grammar] of Object.entries(languages)) hljs.registerLanguage(name, grammar);

const aliases: Record<string, keyof typeof languages> = {
  cjs: "javascript",
  html: "xml",
  js: "javascript",
  jsx: "javascript",
  md: "markdown",
  mjs: "javascript",
  py: "python",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  ts: "typescript",
  tsx: "typescript",
  yml: "yaml",
};

function SafeLink(props: ComponentProps<"a">) {
  return <a {...props} target="_blank" rel="noreferrer noopener" />;
}

function highlightedCode(streaming: boolean) {
  return function Code({ children, className, ...props }: ComponentProps<"code">) {
    const languageName = /(?:^|\s)language-([\w-]+)/.exec(className ?? "")?.[1]?.toLowerCase();
    const language = languageName
      ? (aliases[languageName] ?? (languageName as keyof typeof languages))
      : undefined;
    if (
      streaming ||
      !language ||
      !Object.hasOwn(languages, language) ||
      typeof children !== "string"
    ) {
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    }
    const source = children;
    const result = hljs.highlight(source, { language, ignoreIllegals: true });
    return (
      <code
        className={`${className ?? ""} hljs`.trim()}
        {...props}
        dangerouslySetInnerHTML={{ __html: result.value }}
      />
    );
  };
}

const remarkPlugins = [remarkGfm];
const completedComponents = { a: SafeLink, code: highlightedCode(false) };
const streamingComponents = { a: SafeLink, code: highlightedCode(true) };

const MarkdownRenderer = memo(function MarkdownRenderer({
  children,
  streaming = false,
}: MarkdownRendererProps) {
  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      components={streaming ? streamingComponents : completedComponents}
    >
      {children}
    </ReactMarkdown>
  );
});

export default MarkdownRenderer;
