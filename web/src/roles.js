/* 角色常量与文案：总管理员 / 管理员(xx班) / 资委 / 学委 / 班级成员。
   全站只从这里取，避免到处硬编码角色字符串。 */

export const SUPER_ROLE = "admin";
export const MANAGER_ROLES = ["admin", "class_admin"];
export const STAFF_ROLES = ["admin", "class_admin", "committee", "study"];

export function roleOf(user) {
  return (user && user.role) || "member";
}

export function isSuper(user) {
  return roleOf(user) === SUPER_ROLE;
}

export function isManager(user) {
  return MANAGER_ROLES.includes(roleOf(user));
}

export function isStaff(user) {
  return STAFF_ROLES.includes(roleOf(user));
}

/** 班级名缺省显示成「未指定班级」 */
export function classNameOf(user, fallback = "未指定班级") {
  const name = ((user && user.class_name) || "").trim();
  return name || fallback;
}

/** 身份文案，带上班级后缀，例如「管理员（人工智能启明实验2501班）」 */
export function roleLabel(role, className) {
  const cls = (className || "").trim();
  const wrap = (base) => (cls ? base + "（" + cls + "）" : base);
  switch (role) {
    case "admin": return "总管理员";
    case "class_admin": return wrap("管理员");
    case "committee": return wrap("资委");
    case "study": return wrap("学委");
    default: return "班级成员";
  }
}

export function roleLabelOf(user) {
  return roleLabel(roleOf(user), (user && user.class_name) || "");
}

/** 成员下拉里能选的身份（班级管理员只能任免本班的资委/学委） */
export function roleOptions(superAdmin) {
  const out = [
    { value: "member", label: "班级成员" },
    { value: "committee", label: "资委" },
    { value: "study", label: "学委" },
  ];
  if (superAdmin) {
    out.push({ value: "class_admin", label: "管理员（班级）" });
    out.push({ value: "admin", label: "总管理员" });
  }
  return out;
}
