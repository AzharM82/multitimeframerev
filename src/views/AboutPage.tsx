import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import aboutMd from "../../docs/ABOUT.md?raw";

export function AboutPage() {
  return (
    <div className="bg-bg-card border border-border rounded-lg p-6 md:p-8 prose prose-invert max-w-none">
      <article
        className="
          [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:mb-4 [&_h1]:text-text-primary
          [&_h2]:text-xl [&_h2]:font-bold [&_h2]:mt-8 [&_h2]:mb-3 [&_h2]:text-text-primary
          [&_h3]:text-base [&_h3]:font-bold [&_h3]:mt-6 [&_h3]:mb-2 [&_h3]:text-accent [&_h3]:uppercase [&_h3]:tracking-wider
          [&_h4]:text-sm [&_h4]:font-bold [&_h4]:mt-4 [&_h4]:mb-2 [&_h4]:text-text-secondary [&_h4]:uppercase [&_h4]:tracking-wider
          [&_p]:text-sm [&_p]:leading-6 [&_p]:text-text-primary [&_p]:mb-3
          [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:my-3 [&_ul]:text-sm [&_ul]:space-y-1
          [&_ol]:list-decimal [&_ol]:pl-6 [&_ol]:my-3 [&_ol]:text-sm [&_ol]:space-y-1
          [&_li]:text-text-primary
          [&_strong]:text-text-primary [&_strong]:font-bold
          [&_code]:bg-bg-secondary [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-xs [&_code]:text-accent
          [&_pre]:bg-bg-secondary [&_pre]:p-3 [&_pre]:rounded [&_pre]:overflow-x-auto [&_pre]:text-xs [&_pre]:my-4
          [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-text-primary
          [&_blockquote]:border-l-4 [&_blockquote]:border-accent [&_blockquote]:pl-4 [&_blockquote]:my-3 [&_blockquote]:text-sm [&_blockquote]:text-text-secondary [&_blockquote]:italic
          [&_table]:w-full [&_table]:text-xs [&_table]:my-4 [&_table]:border-collapse
          [&_th]:bg-bg-secondary [&_th]:p-2 [&_th]:text-left [&_th]:font-bold [&_th]:text-text-secondary [&_th]:uppercase [&_th]:tracking-wider [&_th]:border [&_th]:border-border
          [&_td]:p-2 [&_td]:border [&_td]:border-border
          [&_hr]:border-border [&_hr]:my-6
          [&_a]:text-accent [&_a]:hover:underline
        "
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{aboutMd}</ReactMarkdown>
      </article>
    </div>
  );
}
