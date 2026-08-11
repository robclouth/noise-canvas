import { ActionIcon, type ActionIconProps, Button, type ButtonProps } from "@mantine/core";
import { Tooltip } from "@renderer/components/tooltip";
import { helpProps, type UiControlName } from "@renderer/lib/ui-controls";
import { forwardRef } from "react";

/**
 * Buttons that carry their own help: the registry entry named by `help` gives
 * them their tooltip and marks them for the help overlay in one go. Controls
 * that cannot use these — a polymorphic ActionIcon, or a custom widget — spread
 * `helpProps(name)` onto their own element instead.
 */

type HelpActionIconProps = ActionIconProps &
  Omit<React.ComponentPropsWithoutRef<"button">, "color"> & {
    help: UiControlName;
    /** Live detail for a state-dependent hint, shown under the registry text. */
    detail?: React.ReactNode;
  };

export const HelpActionIcon = forwardRef<HTMLButtonElement, HelpActionIconProps>(function HelpActionIcon(
  { help, detail, children, ...props },
  ref,
) {
  return (
    <Tooltip help={help} detail={detail}>
      <ActionIcon ref={ref} {...helpProps(help)} {...props}>
        {children}
      </ActionIcon>
    </Tooltip>
  );
});

type HelpButtonProps = ButtonProps &
  Omit<React.ComponentPropsWithoutRef<"button">, "color"> & {
    help: UiControlName;
    detail?: React.ReactNode;
  };

export const HelpButton = forwardRef<HTMLButtonElement, HelpButtonProps>(function HelpButton(
  { help, detail, children, ...props },
  ref,
) {
  return (
    <Tooltip help={help} detail={detail}>
      <Button ref={ref} {...helpProps(help)} {...props}>
        {children}
      </Button>
    </Tooltip>
  );
});
