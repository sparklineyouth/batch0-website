"use client";
import React, { useRef, useState, useEffect } from "react";
import { useScroll, useTransform, motion, MotionValue } from "framer-motion";

export const ContainerScroll = ({
  titleComponent,
  children,
}: {
  titleComponent: string | React.ReactNode;
  children: React.ReactNode;
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: containerRef });
  // matchMedia is cheaper than resize-listener polling and uses a single
  // browser-managed change event when the breakpoint flips.
  const [isMobile, setIsMobile] = useState(false);
  // Honor prefers-reduced-motion: vestibular-sensitive users get the
  // mocked dashboard at its final pose with no scroll-driven transform.
  // WCAG 2.3.3 / SC 2.3.3.
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    setIsMobile(mq.matches);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduceMotion(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReduceMotion(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const rotateRange: [number, number] = reduceMotion ? [0, 0] : isMobile ? [10, 0] : [20, 0];
  const translateRange: [number, number] = reduceMotion ? [0, 0] : isMobile ? [0, -40] : [0, -100];
  const scaleRange: [number, number] = reduceMotion
    ? [1, 1]
    : isMobile
      ? [0.95, 1]
      : [1.05, 1];

  const rotate = useTransform(scrollYProgress, [0, 1], rotateRange);
  const scale = useTransform(scrollYProgress, [0, 1], scaleRange);
  const translate = useTransform(scrollYProgress, [0, 1], translateRange);

  return (
    <div
      className="h-[42rem] md:h-[80rem] flex items-center justify-center relative px-4 py-8 md:p-20"
      ref={containerRef}
    >
      <div
        className="py-6 md:py-40 w-full relative"
        style={{ perspective: "1000px" }}
      >
        <Header translate={translate} titleComponent={titleComponent} />
        <Card rotate={rotate} scale={scale}>
          {children}
        </Card>
      </div>
    </div>
  );
};

export const Header = ({ translate, titleComponent }: any) => {
  return (
    <motion.div
      style={{ translateY: translate }}
      className="div max-w-5xl mx-auto text-center px-2"
    >
      {titleComponent}
    </motion.div>
  );
};

export const Card = ({
  rotate,
  scale,
  children,
}: {
  rotate: MotionValue<number>;
  scale: MotionValue<number>;
  children: React.ReactNode;
}) => {
  return (
    <motion.div
      style={{
        rotateX: rotate,
        scale,
        boxShadow:
          "0 0 #0000004d, 0 9px 20px #0000004a, 0 37px 37px #00000042, 0 84px 50px #00000026, 0 149px 60px #0000000a, 0 233px 65px #00000003",
        willChange: "transform",
      }}
      className="max-w-5xl mt-6 md:-mt-12 mx-auto h-[22rem] md:h-[40rem] w-full border-2 md:border-4 border-white/15 p-1.5 md:p-6 bg-[#222222] rounded-2xl md:rounded-[30px] shadow-2xl"
    >
      <div className="h-full w-full overflow-hidden rounded-xl md:rounded-2xl bg-zinc-900 md:p-4">
        {children}
      </div>
    </motion.div>
  );
};
