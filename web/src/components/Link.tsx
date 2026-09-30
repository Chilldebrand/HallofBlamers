import { Link as RouterLink, type LinkProps } from "react-router-dom";
import { internalHref } from "../routing";

export default function Link({ href, ...props }: Omit<LinkProps, "to"> & { href: string }) {
  internalHref(href);
  return <RouterLink to={href} {...props} />;
}
