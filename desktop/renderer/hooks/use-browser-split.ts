import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
const storageKey = "beings:browser-width",
  defaultRatio = 0.49;
export function useBrowserSplit(
  panel: RefObject<HTMLElement | null>,
  divider: RefObject<HTMLDivElement | null>,
  open: boolean,
  changed: (dragging: boolean) => void,
) {
  const ratio = useRef(defaultRatio),
    pointer = useRef<number | undefined>(undefined),
    offset = useRef(0);
  const [size, setSize] = useState({
    width: "",
    min: 25,
    max: 75,
    percent: 49,
  });
  const limits = useCallback(() => {
    const total =
      (panel.current?.parentElement
        ?.querySelector(".workspace-stage")
        ?.getBoundingClientRect().width || 0) +
      (panel.current?.getBoundingClientRect().width || 0);
    const min = Math.min(360, total / 2);
    return { total, min, max: Math.max(min, total - 300) };
  }, [panel]);
  const apply = useCallback(
    (width?: number) => {
      if (!panel.current || panel.current.hidden) return;
      const { total, min, max } = limits();
      if (!total) return;
      const next = Math.max(min, Math.min(max, width ?? total * ratio.current));
      if (width !== undefined) ratio.current = next / total;
      const value = {
        width: `${next}px`,
        min: Math.round((min / total) * 100),
        max: Math.round((max / total) * 100),
        percent: Math.round((next / total) * 100),
      };
      setSize((old) =>
        JSON.stringify(old) === JSON.stringify(value) ? old : value,
      );
    },
    [panel, limits],
  );
  const save = () => {
    try {
      localStorage.setItem(storageKey, String(ratio.current));
    } catch {
      /* Optional preference. */
    }
  };
  const finish = useCallback(() => {
    if (pointer.current === undefined) return;
    const id = pointer.current;
    pointer.current = undefined;
    document.body.classList.remove("browser-resizing");
    if (divider.current?.hasPointerCapture(id))
      divider.current.releasePointerCapture(id);
    changed(false);
    save();
  }, [changed, divider]);
  useLayoutEffect(() => {
    try {
      const saved = Number(localStorage.getItem(storageKey));
      if (saved > 0 && saved < 1) ratio.current = saved;
    } catch {
      /* Default ratio. */
    }
  }, []);
  useLayoutEffect(() => {
    if (open) apply();
    else finish();
  }, [open, apply, finish]);
  useEffect(() => {
    const observer = new ResizeObserver(() => apply());
    if (panel.current?.parentElement)
      observer.observe(panel.current.parentElement);
    const stage =
      panel.current?.parentElement?.querySelector(".workspace-stage");
    if (stage) observer.observe(stage);
    window.addEventListener("blur", finish);
    return () => {
      observer.disconnect();
      window.removeEventListener("blur", finish);
      finish();
    };
  }, [apply, finish, panel]);
  return {
    width: size.width,
    props: {
      "aria-valuemin": size.min,
      "aria-valuemax": size.max,
      "aria-valuenow": size.percent,
      "aria-valuetext": `浏览器占 ${size.percent}%`,
      onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
        if (
          event.button !== 0 ||
          pointer.current !== undefined ||
          !panel.current
        )
          return;
        event.preventDefault();
        event.currentTarget.focus();
        offset.current =
          panel.current.getBoundingClientRect().left - event.clientX;
        pointer.current = event.pointerId;
        event.currentTarget.setPointerCapture(event.pointerId);
        document.body.classList.add("browser-resizing");
        changed(true);
      },
      onPointerMove: (event: React.PointerEvent) => {
        if (event.pointerId === pointer.current && panel.current)
          apply(
            panel.current.getBoundingClientRect().right -
              event.clientX -
              offset.current,
          );
      },
      onPointerUp: finish,
      onPointerCancel: finish,
      onLostPointerCapture: finish,
      onDoubleClick: () => {
        ratio.current = defaultRatio;
        apply();
        save();
      },
      onKeyDown: (event: React.KeyboardEvent) => {
        const width = panel.current?.getBoundingClientRect().width || 0,
          { min, max } = limits(),
          step = event.shiftKey ? 60 : 20;
        const next =
          event.key === "ArrowLeft"
            ? width + step
            : event.key === "ArrowRight"
              ? width - step
              : event.key === "Home"
                ? min
                : event.key === "End"
                  ? max
                  : undefined;
        if (next !== undefined) {
          event.preventDefault();
          apply(next);
          save();
        }
      },
    },
  };
}
