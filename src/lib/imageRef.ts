export function parseImageRef(image: string): {
  registry: string;
  repository: string;
  tag: string;
  full: string;
} {
  let registry = "docker.io";
  let repository = image.split("@")[0];
  let tag = "latest";

  const colonIdx = repository.lastIndexOf(":");
  if (colonIdx > -1 && !repository.substring(colonIdx).includes("/")) {
    tag = repository.substring(colonIdx + 1);
    repository = repository.substring(0, colonIdx);
  }

  const parts = repository.split("/");
  if (parts.length >= 2 && (parts[0].includes(".") || parts[0].includes(":") || parts[0] === "localhost")) {
    registry = parts[0];
    repository = parts.slice(1).join("/");
  }

  return { registry, repository, tag, full: `${registry}/${repository}:${tag}` };
}

export function isFloatingTag(tag: string): boolean {
  const floatingTags = ["latest", "main", "master", "dev", "develop", "staging", "nightly", "edge"];
  return floatingTags.includes(tag.toLowerCase());
}
