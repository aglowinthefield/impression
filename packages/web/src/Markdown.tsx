import ReactMarkdown from "react-markdown";

/** Memory text as Markdown. Raw HTML in it is shown as text, never rendered. */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        components={{
          a: ({ node: _, ...p }) => (
            <a {...p} className="link" target="_blank" rel="noreferrer" />
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
