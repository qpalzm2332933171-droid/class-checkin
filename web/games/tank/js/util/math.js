// util/math.js —— 对应 C++ util/Math.cc（全部纯函数，逐行移植）
// 坐标系约定：屏幕坐标，角度 0 = 向右，90 = 向上（polar2Cart 里 y 取负）

function rad2Deg(rad) { return rad * 180 / Math.PI; }

function deg2Rad(deg) { return deg * Math.PI / 180; }

function vector2Angle(v) {
  var rad = Math.atan2(-v.y(), v.x());
  var deg = rad > 0 ? rad2Deg(rad) : 360 + rad2Deg(rad);
  return deg === 360 ? 0 : deg;
}

function polar2Cart(theta, p, O) {
  if (O === undefined) O = new Vec(0, 0);
  var x = O.x() + Math.cos(deg2Rad(theta)) * p;
  var y = O.y() - Math.sin(deg2Rad(theta)) * p;
  return new Vec(x, y);
}

// 旋转矩形的四个角（返回 [tl, tr, bl, br]）
// C++ 里 diagM2 是 static（只按第一次调用的 w,h 算），实际只有 Tank 用固定 20×28，等价
function getCornerVec(pos, angle, w, h) {
  var diagM2 = Math.sqrt(w * w + h * h) / 2.0;
  var a = rad2Deg(Math.atan2(w, h));
  var a1 = a + angle;
  var a2 = angle - a;
  var tl = polar2Cart(a1, diagM2, pos);
  var tr = polar2Cart(a2, diagM2, pos);
  var bl = new Vec(2 * pos.x() - tr.x(), 2 * pos.y() - tr.y());
  var br = new Vec(2 * pos.x() - tl.x(), 2 * pos.y() - tl.y());
  return [tl, tr, bl, br];
}

// SAT：矩形 vs 圆（vec1/vec2 是矩形两条轴）
function checkRectCircleCollision(vec1, vec2, rectCenter, circleCenter, width, height, r) {
  var v = new Vec(circleCenter.x() - rectCenter.x(), circleCenter.y() - rectCenter.y());
  var d1 = Math.abs(v.dot(vec2));
  var d2 = Math.abs(v.dot(vec1));
  var d3 = Math.sqrt(Math.pow(width / 2, 2) + Math.pow(height / 2, 2));
  var d = v.norm();
  return d1 < width / 2 + r && d2 < height / 2 + r && d < d3 + r;
}

function twoPointToGeneral(p1, p2) {
  var x1 = p1.x(), y1 = p1.y(), x2 = p2.x(), y2 = p2.y();
  return { A: y2 - y1, B: x1 - x2, C: x2 * y1 - x1 * y2 };
}

function intersectionOfLines(A1, B1, C1, A2, B2, C2) {
  var m = A1 * B2 - A2 * B1;
  if (m === 0) return null;
  var x = (B1 * C2 - C1 * B2) / m;
  var y = (C1 * A2 - C2 * A1) / m;
  return new Vec(x, y);
}

// 线段相交；交点经 out.v 写回（对应 C++ 的 Vec* i 出参）
function intersectionOfSegments(p1, p2, p3, p4, out) {
  var n1 = new Vec(p1.y() - p2.y(), p2.x() - p1.x());
  var d1 = p1.dot(n1);
  var d3 = p3.dot(n1);
  var d4 = p4.dot(n1);
  if ((d1 - d3) * (d1 - d4) > 0) return false;
  var n2 = new Vec(p4.y() - p3.y(), p3.x() - p4.x());
  d4 = p4.dot(n2);
  d1 = p1.dot(n2);
  var d2 = p2.dot(n2);
  if ((d4 - d1) * (d4 - d2) > 0) return false;
  var g1 = twoPointToGeneral(p1, p2);
  var g2 = twoPointToGeneral(p3, p4);
  var p = intersectionOfLines(g1.A, g1.B, g1.C, g2.A, g2.B, g2.C);
  if (p === null) return false;
  out.v = p;
  return true;
}

function angleFlipX(angle) { return Math.trunc(360 - angle) % 360; }

function angleFlipY(angle) {
  if (angle >= 0 && angle <= 180) return 180 - angle;
  return 540 - angle;
}

// 返回 {first: 朝向轴, second: 垂直轴}
function getUnitVectors(angleDeg) {
  var angleRad = deg2Rad(angleDeg);
  var v1 = new Vec(Math.cos(angleRad), -Math.sin(angleRad));
  var v2 = new Vec(Math.sin(angleRad), Math.cos(angleRad));
  return { first: v1, second: v2 };
}

function getUnitVector(angleDeg) {
  var angleRad = deg2Rad(angleDeg);
  return new Vec(Math.cos(angleRad), -Math.sin(angleRad));
}

// 4 轴 SAT：两个旋转矩形（矩形 1 的 H1 沿其朝向轴）
function checkRectRectCollision(angle1, center1, W1, H1, angle2, center2, W2, H2) {
  var units1 = getUnitVectors(angle1);
  var units2 = getUnitVectors(angle2);
  var axis1 = units1.first, axis2 = units1.second;
  var axis3 = units2.first, axis4 = units2.second;
  var v = center1.minus(center2);
  var projV = Math.abs(v.dot(axis1));
  var projRadius = Math.abs(axis3.dot(axis1)) * H2 / 2 + Math.abs(axis4.dot(axis1)) * W2 / 2;
  if (projRadius + H1 / 2 <= projV) return false;
  projV = Math.abs(v.dot(axis2));
  projRadius = Math.abs(axis3.dot(axis2)) * H2 / 2 + Math.abs(axis4.dot(axis2)) * W2 / 2;
  if (projRadius + W1 / 2 <= projV) return false;
  projV = Math.abs(v.dot(axis3));
  projRadius = Math.abs(axis1.dot(axis3)) * H1 / 2 + Math.abs(axis2.dot(axis3)) * W1 / 2;
  if (projRadius + H2 / 2 <= projV) return false;
  projV = Math.abs(v.dot(axis4));
  projRadius = Math.abs(axis1.dot(axis4)) * H1 / 2 + Math.abs(axis2.dot(axis4)) * W1 / 2;
  if (projRadius + W2 / 2 <= projV) return false;
  return true;
}

function distanceOfTwoPoints(p1, p2) { return p2.minus(p1).norm(); }

// 角度 a 沿最短弧朝 b 转最多 step 度（0/360 环绕安全，返回整数角度）
function rotateToward(a, b, step) {
  var d = ((b - a + 540) % 360) - 180;   // -180..180，正 = 逆时针
  if (Math.abs(d) <= step) return Math.trunc(((b % 360) + 360) % 360);
  return Math.trunc((a + (d > 0 ? step : -step) + 360) % 360);
}

function angleBetweenVectors(v1, v2) {
  var cos = v1.dot(v2) / (v1.norm() * v2.norm());
  return rad2Deg(Math.acos(cos));
}

// C++ 每次调用都新建 random_device + mt19937；JS 直接 Math.random 等价
function getRandomNumber(low, high) {
  return Math.floor(Math.random() * (high - low + 1)) + low;
}
