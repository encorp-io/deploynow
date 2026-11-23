/** The running DeployNow version: the release tag the image was built from, else package.json's. */
export const VERSION: string = process.env.NEXT_PUBLIC_DEPLOYNOW_VERSION || "dev";
