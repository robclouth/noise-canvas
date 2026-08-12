import { pitchUvToViewUvY, zoomedToScreen } from "@renderer/lib/utils";
import { Vector2 } from "three";
import type { StampMarker } from "./stamp-layout";

/** Where a stamp sits on the lane, as fractions of it, y measured down from the top. */
export interface StampBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A stamp needs this many pixels on both axes before its label fits inside it. */
export const MIN_LABEL_WIDTH_PX = 54;
export const MIN_LABEL_HEIGHT_PX = 22;

/**
 * Places one stamp on the lane. Stamps are laid out in pitch UV, which runs up
 * from the file's lowest band, while the lane is drawn top-down, so the box's
 * top edge comes from the stamp's high-pitch edge.
 */
export function stampBox(stamp: StampMarker, zoom: Vector2, offset: Vector2): StampBox {
  const left = zoomedToScreen(new Vector2(stamp.blX, 0), zoom, offset).x;
  const right = zoomedToScreen(new Vector2(stamp.blX + stamp.sizeX, 0), zoom, offset).x;
  const top = zoomedToScreen(new Vector2(0, pitchUvToViewUvY(stamp.blY + stamp.sizeY)), zoom, offset).y;
  const bottom = zoomedToScreen(new Vector2(0, pitchUvToViewUvY(stamp.blY)), zoom, offset).y;

  return { left, top, width: right - left, height: bottom - top };
}

/** False when the box has scrolled entirely off the lane. */
export function isOnLane(box: StampBox): boolean {
  return box.left < 1 && box.left + box.width > 0 && box.top < 1 && box.top + box.height > 0;
}

/** Whether the box has room for its brush name and values. */
export function fitsLabel(box: StampBox, laneWidth: number, laneHeight: number): boolean {
  return box.width * laneWidth >= MIN_LABEL_WIDTH_PX && box.height * laneHeight >= MIN_LABEL_HEIGHT_PX;
}
