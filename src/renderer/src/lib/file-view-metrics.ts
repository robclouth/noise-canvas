/** Heights the parts of a file's box are laid out at, in pixels. */

/** The onset markers above the spectrogram. */
export const ONSET_LEGEND_HEIGHT = 15;

/** The output level ramp above the onsets. */
export const LEVEL_STRIP_HEIGHT = Math.round(ONSET_LEGEND_HEIGHT / 2);

/** The beat and time ruler below the spectrogram. */
export const TIME_LEGEND_HEIGHT = 15;

/** The spectrogram itself. */
export const CANVAS_HEIGHT = 400;

/**
 * What sits under the file header, loading or drawn. Fixed, so a file that
 * finishes analysing does not grow its box and shove everything below it down.
 */
export const FILE_VIEW_BODY_HEIGHT = CANVAS_HEIGHT + LEVEL_STRIP_HEIGHT + ONSET_LEGEND_HEIGHT + TIME_LEGEND_HEIGHT;
