"use client";

import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal, flushSync } from "react-dom";

const OPEN_MENU_EVENT = "reservation-actions-menu:open";
const MENU_WIDTH = 240;
const VIEWPORT_GAP = 8;

type MenuPosition = {
  left: number;
  top: number;
};

export function ReservationActionsMenu({ children }: { children: ReactNode }) {
  const instanceId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<MenuPosition>({ left: 0, top: 0 });

  const closeMenu = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => buttonRef.current?.focus());
    }
  }, []);

  const closeMenuBeforeNavigation = useCallback(() => {
    flushSync(() => setOpen(false));
  }, []);

  const openMenu = () => {
    window.dispatchEvent(
      new CustomEvent(OPEN_MENU_EVENT, { detail: instanceId }),
    );
    setOpen(true);
  };

  useEffect(() => {
    const handleAnotherMenu = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== instanceId) {
        setOpen(false);
      }
    };

    window.addEventListener(OPEN_MENU_EVENT, handleAnotherMenu);
    return () => window.removeEventListener(OPEN_MENU_EVENT, handleAnotherMenu);
  }, [instanceId]);

  useEffect(() => {
    const resetAfterNavigation = () => setOpen(false);

    window.addEventListener("pageshow", resetAfterNavigation);
    window.addEventListener("popstate", resetAfterNavigation);
    return () => {
      window.removeEventListener("pageshow", resetAfterNavigation);
      window.removeEventListener("popstate", resetAfterNavigation);
    };
  }, []);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !buttonRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        closeMenu();
      }
    };
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu(true);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [closeMenu, open]);

  useLayoutEffect(() => {
    if (!open) return;

    const updatePosition = () => {
      const button = buttonRef.current;
      if (!button) return;

      const rect = button.getBoundingClientRect();
      const menuHeight = menuRef.current?.offsetHeight ?? 280;
      const spaceBelow = window.innerHeight - rect.bottom;
      const shouldOpenAbove =
        spaceBelow < menuHeight + VIEWPORT_GAP && rect.top > spaceBelow;
      const top = shouldOpenAbove
        ? Math.max(VIEWPORT_GAP, rect.top - menuHeight - VIEWPORT_GAP)
        : Math.min(
            rect.bottom + VIEWPORT_GAP,
            window.innerHeight - menuHeight - VIEWPORT_GAP,
          );
      const left = Math.min(
        Math.max(VIEWPORT_GAP, rect.right - MENU_WIDTH),
        window.innerWidth - MENU_WIDTH - VIEWPORT_GAP,
      );

      setPosition({ left, top: Math.max(VIEWPORT_GAP, top) });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    window.requestAnimationFrame(() => {
      updatePosition();
      const items = menuRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled])',
      );
      items?.forEach((item) => item.setAttribute("role", "menuitem"));
      items?.[0]?.focus();
    });

    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;

    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled])',
      ) ?? [],
    );
    if (!items.length) return;

    event.preventDefault();
    const currentIndex = items.indexOf(document.activeElement as HTMLElement);
    const nextIndex =
      event.key === "ArrowDown"
        ? (currentIndex + 1) % items.length
        : (currentIndex - 1 + items.length) % items.length;
    items[nextIndex]?.focus();
  };

  return (
    <>
      <button
        aria-controls={open ? instanceId + "-menu" : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-white px-3 text-sm font-semibold text-ink transition hover:border-gold focus:outline-none focus:ring-4 focus:ring-gold/10"
        onClick={() => (open ? closeMenu() : openMenu())}
        ref={buttonRef}
        type="button"
      >
        Manage
        <span aria-hidden="true" className="text-[10px] text-muted">
          &#9662;
        </span>
      </button>

      {open &&
        createPortal(
          <div
            aria-label="Reservation actions"
            className="fixed z-[100] w-60 rounded-xl border border-border bg-white p-1.5 shadow-2xl [&_a]:flex [&_a]:min-h-10 [&_a]:w-full [&_a]:items-center [&_a]:rounded-lg [&_a]:px-3 [&_a]:py-2 [&_a]:text-left [&_a]:text-sm [&_a]:font-semibold [&_a]:no-underline [&_a]:transition [&_a:hover]:bg-canvas [&_button]:flex [&_button]:min-h-10 [&_button]:w-full [&_button]:items-center [&_button]:rounded-lg [&_button]:px-3 [&_button]:py-2 [&_button]:text-left [&_button]:text-sm [&_button]:font-semibold [&_button]:no-underline [&_button]:transition [&_button:hover]:bg-canvas [&_form]:w-full"
            onBlur={(event) => {
              const nextTarget = event.relatedTarget as Node | null;
              if (
                nextTarget &&
                !menuRef.current?.contains(nextTarget) &&
                !buttonRef.current?.contains(nextTarget)
              ) {
                closeMenu();
              }
            }}
            id={instanceId + "-menu"}
            onClickCapture={(event) => {
              if (
                event.target instanceof Element &&
                event.target.closest("a")
              ) {
                closeMenuBeforeNavigation();
              }
            }}
            onKeyDown={handleMenuKeyDown}
            onSubmitCapture={() => {
              window.requestAnimationFrame(() => closeMenu());
            }}
            ref={menuRef}
            role="menu"
            style={{ left: position.left, top: position.top }}
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}

export function ReservationActionsSeparator() {
  return <div aria-hidden="true" className="my-1 border-t border-border" />;
}
