// SPDX-License-Identifier: Apache-2.0
// The info tooltip shown on hovering or focusing a field's "i" icon: YAML
// key, required/optional, the description, terms and a separate
// engine-effect line. The shared tooltip layer draws and places it.

import { Info } from "lucide-react";
import type { FieldDoc } from "./docs.ts";
import { useTooltip } from "./Tooltip.tsx";

function InfoContent({ doc }: { doc: FieldDoc }) {
  return (
    <>
      {!doc.hideKey && (
        <div className="info-tooltip-key">
          {doc.yamlKey} <span className="info-tooltip-tag">{doc.required ? "required" : "optional"}</span>
        </div>
      )}
      <div className="info-tooltip-desc">{doc.description}</div>
      {doc.terms && (
        <ul className="info-tooltip-terms">
          {doc.terms.map(({ term, text }) => (
            <li key={term}>
              <strong>{term}:</strong> {text}
            </li>
          ))}
        </ul>
      )}
      {doc.engineEffect && <div className="info-tooltip-effect">Engine effect: {doc.engineEffect}</div>}
    </>
  );
}

export function InfoTip({ doc }: { doc: FieldDoc }) {
  const tooltip = useTooltip();
  const show = (anchor: Element) => tooltip.show(anchor, <InfoContent doc={doc} />);
  return (
    <span className="info-tip-wrap">
      <span
        className="info-icon"
        role="img"
        aria-label="field info"
        tabIndex={0}
        onMouseEnter={(e) => show(e.currentTarget)}
        onMouseLeave={(e) => tooltip.hide(e.currentTarget)}
        onFocus={(e) => show(e.currentTarget)}
        onBlur={(e) => tooltip.hide(e.currentTarget)}
      >
        <Info size={10} strokeWidth={1.75} />
      </span>
    </span>
  );
}

export function FieldLabel({ label, doc }: { label: string; doc: FieldDoc }) {
  return (
    <span className="field-label-row">
      {label}
      <span className={`field-tag ${doc.required ? "is-required" : "is-optional"}`}>
        {doc.required ? "required" : "optional"}
      </span>
      <InfoTip doc={doc} />
    </span>
  );
}
