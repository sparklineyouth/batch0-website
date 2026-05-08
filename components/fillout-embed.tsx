"use client";
import React, { useEffect } from "react";

declare global {
  interface Window {
    FilloutStandardEmbed?: { rerender?: () => void };
  }
}

export default function FilloutEmbed({ formId }: { formId: string }) {
  useEffect(() => {
    const existing = document.querySelector(
      'script[src="https://server.fillout.com/embed/v1/"]'
    ) as HTMLScriptElement | null;

    if (!existing) {
      const s = document.createElement("script");
      s.src = "https://server.fillout.com/embed/v1/";
      s.async = true;
      document.body.appendChild(s);
    } else {
      window.FilloutStandardEmbed?.rerender?.();
    }
  }, []);

  return (
    <div
      data-fillout-id={formId}
      data-fillout-embed-type="standard"
      data-fillout-inherit-parameters
      data-fillout-dynamic-resize
      style={{ width: "100%", height: "100%", minHeight: "640px" }}
    />
  );
}
