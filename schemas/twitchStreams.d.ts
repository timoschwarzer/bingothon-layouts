/* tslint:disable */
/**
 * This file was automatically generated by json-schema-to-typescript.
 * DO NOT MODIFY IT BY HAND. Instead, modify the source JSONSchema file,
 * and run json-schema-to-typescript to regenerate this file.
 */

export type TwitchStreams = {
  channel: string;
  widthPercent: number;
  heightPercent: number;
  topPercent: number;
  leftPercent: number;
  quality: string;
  volume: number;
  paused: boolean;
  delay: number;
  availableQualities: {
    name: string;
    group: string;
  }[];
}[];
