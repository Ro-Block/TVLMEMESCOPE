import { createContext, useContext, useState, type ReactNode } from 'react';

interface Tip {
  x: number;
  y: number;
  content: ReactNode;
}

const Ctx = createContext<{ show: (e: { clientX: number; clientY: number }, c: ReactNode) => void; hide: () => void }>({ show: () => {}, hide: () => {} });

export function TooltipProvider({ children }: { children: ReactNode }) {
  const [tip, setTip] = useState<Tip | null>(null);
  const show = (e: { clientX: number; clientY: number }, content: ReactNode) => setTip({ x: e.clientX, y: e.clientY, content });
  const hide = () => setTip(null);
  const w = typeof window !== 'undefined' ? window.innerWidth : 1200;
  return (
    <Ctx.Provider value={{ show, hide }}>
      {children}
      {tip && (
        <div className="tooltip" style={{ left: tip.x > w - 240 ? tip.x - 220 : tip.x + 14, top: tip.y + 14 }}>
          {tip.content}
        </div>
      )}
    </Ctx.Provider>
  );
}

export const useTooltip = () => useContext(Ctx);

export function TipRows({ title, rows }: { title: ReactNode; rows: [string, ReactNode][] }) {
  return (
    <>
      <div className="t-title">{title}</div>
      {rows.map(([k, v]) => (
        <div className="t-row" key={k}>
          <span>{k}</span>
          <b>{v}</b>
        </div>
      ))}
    </>
  );
}
