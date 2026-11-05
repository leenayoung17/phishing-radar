import Image from "next/image";
import { IMAGES, type ImageKey } from "@/lib/assets";

// 서비스 아이콘·결과 그림을 표시한다. 그림은 장식이므로 옆의 글이 의미를 전달한다(alt 는 비움).
export default function StatusImage({
  name,
  size = 56,
  className = "",
}: {
  name: ImageKey;
  size?: number;
  className?: string;
}) {
  const src = IMAGES[name];
  return (
    <Image
      src={src}
      alt=""
      width={size}
      height={size}
      unoptimized={src.endsWith(".svg")}
      className={"shrink-0 object-contain " + className}
    />
  );
}
