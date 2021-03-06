;(function(){
'use strict'
var container, stats;
var camera, scene, renderer;
var group;
var background;
var overlay, overlayCamera;
var navballMesh, prograde, retrograde;
var timescaleControl;
var throttleControl;
var speedControl;
var orbitalElementControl;
var statsControl;
var settingsControl;
var altitudeControl;
var messageControl;
var mouseX = 0, mouseY = 0;
var cameraControls;
var grids;

var windowHalfX = window.innerWidth / 2;
var windowHalfY = window.innerHeight / 2;
var viewScale = 100;

var simTime, startTime;
var realTime;
var center_select = false;
var select_idx = 0;
var select_obj = null;
var nlips_enable = true;
var grid_enable = false;
var sync_rotate = false;

var up = false;
var down = false;
var left = false;
var right = false;
var counterclockwise = false;
var clockwise = false;
var accelerate = false;
var decelerate = false;

var sun;
var light;

var selectedOrbitMaterial;

var AU = 149597871; // Astronomical unit in kilometers
var GMsun = 1.327124400e11 / AU / AU/ AU; // Product of gravitational constant (G) and Sun's mass (Msun)
var epsilon = 1e-40; // Doesn't the machine epsilon depend on browsers!??
var timescale = 1e0; // This is not a constant; it can be changed by the user
var rad_per_deg = Math.PI / 180; // Radians per degrees
var navballRadius = 64;

function AxisAngleQuaternion(x, y, z, angle){
	var q = new THREE.Quaternion();
	q.setFromAxisAngle(new THREE.Vector3(x, y, z), angle);
	return q;
}

// CelestialBody class
function CelestialBody(parent, position, vertex, orbitColor, GM){
	this.position = position;
	this.velocity = new THREE.Vector3();
	this.quaternion = new THREE.Quaternion();
	this.angularVelocity = new THREE.Vector3();
	if(orbitColor) this.orbitMaterial = new THREE.LineBasicMaterial({color: orbitColor});
	this.children = [];
	this.parent = parent;
	this.GM = GM || GMsun;
	if(parent) parent.children.push(this);
	this.radius = 1 / AU;
	this.controllable = false;
	this.throttle = 0.;
	this.totalDeltaV = 0.;
	this.ignitionCount = 0;
}

CelestialBody.prototype.init = function(){
	this.ascending_node = Math.random() * Math.PI * 2;
	this.epoch = Math.random();
	this.mean_anomaly = Math.random();
	this.update();
};

CelestialBody.prototype.get_eccentric_anomaly = function(time){
	// Calculates eccentric anomaly from mean anomaly in first order approximation
	// see http://en.wikipedia.org/wiki/Eccentric_anomaly
	var td = time - this.epoch;
	var period = 2 * Math.PI * Math.sqrt(Math.pow(this.semimajor_axis * AU, 3) / this.parent.GM);
	var now_anomaly = this.mean_anomaly + td * 2 * Math.PI / period;
	return now_anomaly + this.eccentricity * Math.sin(now_anomaly);
};

CelestialBody.prototype.getWorldPosition = function(){
	if(this.parent)
		return this.parent.getWorldPosition().clone().add(this.position);
	else
		return this.position;
};

// Update orbital elements from position and velocity.
// The whole discussion is found in chapter 4.4 in
// https://www.academia.edu/8612052/ORBITAL_MECHANICS_FOR_ENGINEERING_STUDENTS
CelestialBody.prototype.update = function(){
	function visualPosition(o){
		var position = o.getWorldPosition();
		if(select_obj && center_select)
			position.sub(select_obj.getWorldPosition());
		position.multiplyScalar(viewScale);
		return position;
	}
	/// NLIPS: Non-Linear Inverse Perspective Scrolling
	/// Idea originally found in a game Homeworld that enable
	/// distant small objects to appear on screen in recognizable size
	/// but still renders in real scale when zoomed up.
	function nlipsFactor(o){
		if(!nlips_enable)
			return 1;
		var g_nlips_factor = 1e6;
		var d = visualPosition(o).distanceTo(camera.position) / viewScale;
		var f = d / o.radius * g_nlips_factor + 1;
		return f;
	}

	/// Calculate position of periapsis and apoapsis on the screen
	/// for placing overlay icons.
	/// peri = -1 if periapsis, otherwise 1
	function calcApsePosition(peri, apsis){
		var worldPos = e.clone().normalize().multiplyScalar(peri * scope.semimajor_axis * (1 - peri * scope.eccentricity)).sub(scope.position);
		var cameraPos = worldPos.multiplyScalar(viewScale).applyMatrix4(camera.matrixWorldInverse);
		var persPos = cameraPos.applyProjection(camera.projectionMatrix);
		persPos.x *= windowHalfX;
		persPos.y *= windowHalfY;
		persPos.y -= peri * 8;
		if(0 < persPos.z && persPos.z < 1){
			apsis.position.copy(persPos);
			apsis.visible = true;
		}
		else
			apsis.visible = false;
	};
	var scope = this;

	if(this.vertex)
		this.vertex.copy(visualPosition(this));

	if(this.model){
		this.model.position.copy(visualPosition(this));
		this.model.scale.set(1,1,1).multiplyScalar(nlipsFactor(this));
		this.model.quaternion.copy(this.quaternion);
	}

	if(this.parent){
		// Angular momentum vectors
		var ang = this.velocity.clone().cross(this.position);
		var r = this.position.length();
		var v = this.velocity.length();
		// Node vector
		var N = (new THREE.Vector3(0, 0, 1)).cross(ang);
		// Eccentricity vector
		var e = this.position.clone().multiplyScalar(1 / this.parent.GM * ((v * v - this.parent.GM / r))).sub(this.velocity.clone().multiplyScalar(this.position.dot(this.velocity) / this.parent.GM));
		this.eccentricity = e.length();
		this.inclination = Math.acos(-ang.z / ang.length());
		// Avoid zero division
		if(N.lengthSq() <= epsilon)
			this.ascending_node = 0;
		else{
			this.ascending_node = Math.acos(N.x / N.length());
			if(N.y < 0) this.ascending_node = 2 * Math.PI - this.ascending_node;
		}
		this.semimajor_axis = 1 / (2 / r - v * v / this.parent.GM);

		// Rotation to perifocal frame
		var planeRot = AxisAngleQuaternion(0, 0, 1, this.ascending_node - Math.PI / 2).multiply(AxisAngleQuaternion(0, 1, 0, Math.PI - this.inclination));

		var headingApoapsis = -this.position.dot(this.velocity)/Math.abs(this.position.dot(this.velocity));

		// Avoid zero division and still get the correct answer when N == 0.
		// This is necessary to draw orbit with zero inclination and nonzero eccentricity.
		if(N.lengthSq() <= epsilon || e.lengthSq() <= epsilon)
			this.argument_of_perihelion = Math.atan2(-e.y, e.x);
		else
			this.argument_of_perihelion = Math.acos(N.dot(e) / N.length() / e.length());
		if(e.z < 0) this.argument_of_perihelion = 2 * Math.PI - this.argument_of_perihelion;

		// Total rotation of the orbit
		var rotation = planeRot.clone().multiply(AxisAngleQuaternion(0, 0, 1, this.argument_of_perihelion));

		// Show orbit information
		if(this === select_obj)
			orbitalElementControl.setText(
				  'e=' + this.eccentricity.toFixed(10) + '<br>'
				+ ' a=' + this.semimajor_axis.toFixed(10) + '<br>'
				+ ' i=' + (this.inclination / Math.PI).toFixed(10) + '<br>'
				+ ' Omega=' + (this.ascending_node / Math.PI).toFixed(10) + '<br>'
				+ ' w=' + (this.argument_of_perihelion / Math.PI).toFixed(10) + '<br>'
				+ ' head=' + headingApoapsis.toFixed(5) + '<br>'
//							+ ' omega=' + this.angularVelocity.x.toFixed(10) + ',' + '<br>' + this.angularVelocity.y.toFixed(10) + ',' + '<br>' + this.angularVelocity.z.toFixed(10)
				);

		// If eccentricity is over 1, the trajectory is a hyperbola.
		// It could be parabola in case of eccentricity == 1, but we ignore
		// this impractical case for now.
		if(1 < this.eccentricity){
			// Allocate the hyperbolic shape and mesh only if necessary,
			// since most of celestial bodies are all on permanent elliptical orbit.
			if(!this.hyperbolicGeometry)
				this.hyperbolicGeometry = new THREE.Geometry();

			// Calculate the vertices every frame since the hyperbola changes shape
			// depending on orbital elements.
			var thetaInf = Math.acos(-1 / this.eccentricity);
			this.hyperbolicGeometry.vertices.length = 0;
			var h2 = ang.lengthSq();
			for(var i = -19; i < 20; i++){
				// Transform by square root to make far side of the hyperbola less "polygonic"
				var isign = i < 0 ? -1 : 1;
				var theta = thetaInf * isign * Math.sqrt(Math.abs(i) / 20);
				this.hyperbolicGeometry.vertices.push(
					new THREE.Vector3( Math.sin(theta), Math.cos(theta), 0 )
					.multiplyScalar(h2 / this.parent.GM / (1 + this.eccentricity * Math.cos(theta))) );
			}
			// Signal three.js to update the vertices
			this.hyperbolicGeometry.verticesNeedUpdate = true;

			// Allocate hyperbola mesh and add it to the scene.
			if(!this.hyperbolicMesh){
				this.hyperbolicMesh = new THREE.Line(this.hyperbolicGeometry, this.orbitMaterial);
				scene.add(this.hyperbolicMesh);
			}
			this.hyperbolicMesh.quaternion.copy(rotation);
			this.hyperbolicMesh.scale.x = viewScale;
			this.hyperbolicMesh.scale.y = viewScale;
			this.hyperbolicMesh.position.copy(this.parent.getWorldPosition());
			if(select_obj && center_select)
				this.hyperbolicMesh.position.sub(select_obj.getWorldPosition());
			this.hyperbolicMesh.position.multiplyScalar(viewScale);

			// Switch from ellipse to hyperbola
			this.hyperbolicMesh.visible = true;
			if(this.orbit)
				this.orbit.visible = false;
		}
		else if(this.hyperbolicMesh){
			// Switch back to ellipse from hyperbola
			if(this.orbit)
				this.orbit.visible = true;
			this.hyperbolicMesh.visible = false;
		}

		// Apply transformation to orbit mesh
		if(this.orbit){
			this.orbit.quaternion.copy(rotation);
			this.orbit.scale.x = this.semimajor_axis * viewScale * Math.sqrt(1. - this.eccentricity * this.eccentricity);
			this.orbit.scale.y = this.semimajor_axis * viewScale;
			this.orbit.position.copy(new THREE.Vector3(0, -this.semimajor_axis * this.eccentricity, 0).applyQuaternion(rotation).add(this.parent.getWorldPosition()));
			if(select_obj && center_select)
				this.orbit.position.sub(select_obj.getWorldPosition());
			this.orbit.position.multiplyScalar(viewScale);
		}

		if(this.apoapsis){
			// if eccentricity is zero or more than 1, apoapsis is not defined
			if(this === select_obj && 0 < this.eccentricity && this.eccentricity < 1)
				calcApsePosition(-1, this.apoapsis);
			else
				this.apoapsis.visible = false;
		}
		if(this.periapsis){
			// if eccentricity is zero, periapsis is not defined
			if(this === select_obj && 0 < this.eccentricity)
				calcApsePosition(1, this.periapsis);
			else
				this.periapsis.visible = false;
		}
	}

	for(var i = 0; i < this.children.length; i++){
		var a = this.children[i];
		a.update();
	}

};

function init() {

	container = document.getElementById( 'container' );

	camera = new THREE.PerspectiveCamera( 60, window.innerWidth / window.innerHeight, 1, 10000 );
	camera.position.y = 300;
	camera.position.z = 1000;
	camera.up.set(0,0,1);

	background = new THREE.Scene();
	background.rotation.x = Math.PI / 2;
	var loader = new THREE.TextureLoader();
	loader.load( 'images/hipparcoscyl1.jpg', function ( texture ) {

		var geometry = new THREE.SphereGeometry( 2, 20, 20 );

		var material = new THREE.MeshBasicMaterial( { map: texture, overdraw: 0.5, depthTest: false, depthWrite: false, side: THREE.BackSide } );
		material.depthWrite = false;
		var mesh = new THREE.Mesh(geometry, material);
		background.add(mesh);

	} );

	overlayCamera = new THREE.OrthographicCamera( window.innerWidth / - 2, window.innerWidth / 2, window.innerHeight / 2, window.innerHeight / - 2, -1000, 1000 );
	window.addEventListener('resize', function(){
		overlayCamera.left = window.innerWidth / - 2;
		overlayCamera.right = window.innerWidth / 2;
		overlayCamera.top = window.innerHeight / 2;
		overlayCamera.bottom = window.innerHeight / - 2;
		overlayCamera.updateProjectionMatrix();
	});

	overlay = new THREE.Scene();
	var loader = new THREE.TextureLoader();
	loader.load( 'images/navball.png', function ( texture ) {

		var geometry = new THREE.SphereGeometry( navballRadius, 20, 20 );

		var material = new THREE.MeshBasicMaterial( { map: texture, overdraw: 0.5, depthTest: false, depthWrite: false } );
		navballMesh = new THREE.Mesh(geometry, material);
		overlay.add(navballMesh);

		var spriteMaterial = new THREE.SpriteMaterial({
			map: THREE.ImageUtils.loadTexture( "images/watermark.png" ),
			depthTest: false,
			depthWrite: false,
			transparent: true,
		});
		var watermark = new THREE.Sprite(spriteMaterial);
		watermark.scale.set(64, 32, 64);
		navballMesh.add(watermark);
	} );

	var spriteGeometry = new THREE.PlaneGeometry( 40, 40 );
    prograde = new THREE.Mesh(spriteGeometry,
		new THREE.MeshBasicMaterial({
			map: THREE.ImageUtils.loadTexture( "images/prograde.png" ),
			color: 0xffffff,
			side: THREE.DoubleSide,
			depthTest: false,
			depthWrite: false,
			transparent: true,
		} )
	);
    overlay.add(prograde);
	retrograde = new THREE.Mesh(spriteGeometry,
		new THREE.MeshBasicMaterial({
			map: THREE.ImageUtils.loadTexture( "images/retrograde.png" ),
			color: 0xffffff,
			side: THREE.DoubleSide,
			depthTest: false,
			depthWrite: false,
			transparent: true,
		} )
	);
    overlay.add(retrograde);

	scene = new THREE.Scene();

	group = new THREE.Object3D();
	scene.add( group );

	var material = new THREE.ParticleSystemMaterial( { size: 0.1 } );

	// Sun
	var Rsun = 695800.;
	var sgeometry = new THREE.SphereGeometry( Rsun / AU * viewScale, 20, 20 );

	var sunMesh = new THREE.Mesh( sgeometry, material );
	group.add( sunMesh );

	// Sun light
	light = new THREE.PointLight( 0xffffff, 1, 0, 1e-6 );
	scene.add( light );
	scene.add( new THREE.AmbientLight( 0x202020 ) );

	var meshMaterial = new THREE.LineBasicMaterial({color: 0x3f3f3f});
	var meshGeometry = new THREE.Geometry();
	for(var x = -10; x <= 10; x++)
		meshGeometry.vertices.push( new THREE.Vector3( -10, x, 0 ), new THREE.Vector3(10, x, 0));
	for(var x = -10; x <= 10; x++)
		meshGeometry.vertices.push( new THREE.Vector3( x, -10, 0 ), new THREE.Vector3(x, 10, 0));
	grids = new THREE.Object3D();
	var mesh = new THREE.LineSegments(meshGeometry, meshMaterial);
	mesh.scale.x = mesh.scale.y = 100;
	grids.add(mesh);
	var mesh2 = new THREE.LineSegments(meshGeometry, meshMaterial);
	mesh2.scale.x = mesh2.scale.y = 10000 / AU * 100;
	grids.add(mesh2);

	function addAxis(axisVector, color){
		var axisXMaterial = new THREE.LineBasicMaterial({color: color});
		var axisXGeometry = new THREE.Geometry();
		axisXGeometry.vertices.push(new THREE.Vector3(0,0,0), axisVector);
		var axisX = new THREE.Line(axisXGeometry, axisXMaterial);
		axisX.scale.multiplyScalar(100);
		grids.add(axisX);
	}
	addAxis(new THREE.Vector3(100,0,0), 0xff0000);
	addAxis(new THREE.Vector3(0,100,0), 0x00ff00);
	addAxis(new THREE.Vector3(0,0,100), 0x0000ff);

	scene.add(grids);

	var orbitMaterial = new THREE.LineBasicMaterial({color: 0x3f3f7f});
	CelestialBody.prototype.orbitMaterial = orbitMaterial; // Default orbit material
	selectedOrbitMaterial = new THREE.LineBasicMaterial({color: 0xff7fff});
	var orbitGeometry = new THREE.Geometry();
	var curve = new THREE.EllipseCurve(0, 0, 1, 1,
		0, Math.PI * 2, false, 90);
	var path = new THREE.Path( curve.getPoints( 256 ) );
	var orbitGeometry = path.createPointsGeometry( 256 );

	// Add a planet having desired orbital elements. Note that there's no way to specify anomaly (phase) on the orbit right now.
	// It's a bit difficult to calculate in Newtonian dynamics simulation.
	function AddPlanet(semimajor_axis, eccentricity, inclination, ascending_node, argument_of_perihelion, color, GM, parent, texture, radius, params){
		var rotation = AxisAngleQuaternion(0, 0, 1, ascending_node - Math.PI / 2)
			.multiply(AxisAngleQuaternion(0, 1, 0, Math.PI - inclination))
			.multiply(AxisAngleQuaternion(0, 0, 1, argument_of_perihelion));
		var group = new THREE.Object3D();
		var ret = new CelestialBody(parent || sun, new THREE.Vector3(0, 1 - eccentricity, 0).multiplyScalar(semimajor_axis).applyQuaternion(rotation), group.position, color, GM);
		ret.model = group;
		ret.radius = radius;
		scene.add( group );

		if(texture){
			var loader = new THREE.TextureLoader();
			loader.load( texture || 'images/land_ocean_ice_cloud_2048.jpg', function ( texture ) {

				var geometry = new THREE.SphereGeometry( 1, 20, 20 );

				var material = new THREE.MeshLambertMaterial( { map: texture, color: 0xffffff, shading: THREE.FlatShading, overdraw: 0.5 } );
				var mesh = new THREE.Mesh( geometry, material );
				var radiusInAu = viewScale * (radius || 6534) / AU;
				mesh.scale.set(radiusInAu, radiusInAu, radiusInAu);
				mesh.rotation.x = Math.PI / 2;
				group.add( mesh );

			} );
		}
		else if(params.modelName){
			var loader = new THREE.OBJLoader();
			loader.load( params.modelName, function ( object ) {
				var radiusInAu = 100 * (radius || 6534) / AU;
				object.scale.set(radiusInAu, radiusInAu, radiusInAu);
				group.add( object );
			} );
			var blastGroup = new THREE.Object3D();
			group.add(blastGroup);
			blastGroup.visible = false;
			blastGroup.position.x = -60 / AU;
			ret.blastModel = blastGroup;
			var spriteMaterial = new THREE.SpriteMaterial({
				map: THREE.ImageUtils.loadTexture( "images/blast.png" ),
				blending: THREE.AdditiveBlending,
				depthWrite: false,
				transparent: true,
			});
			var blast = new THREE.Sprite(spriteMaterial);
			blast.position.x = -30 / AU;
			blast.scale.multiplyScalar(100 / AU);
			blastGroup.add(blast);
			var blast2 = new THREE.Sprite(spriteMaterial);
			blast2.position.x = -60 / AU;
			blast2.scale.multiplyScalar(50 / AU);
			blastGroup.add(blast2);
			var blast2 = new THREE.Sprite(spriteMaterial);
			blast2.position.x = -80 / AU;
			blast2.scale.multiplyScalar(30 / AU);
			blastGroup.add(blast2);
		}

		if(params && params.controllable)
			ret.controllable = params.controllable;

		ret.soi = params && params.soi ? params.soi / AU : 0;

		ret.apoapsis = new THREE.Sprite(new THREE.SpriteMaterial({
			map: THREE.ImageUtils.loadTexture('images/apoapsis.png'),
			transparent: true,
		}));
		ret.apoapsis.scale.set(16,16,16);
		overlay.add(ret.apoapsis);

		ret.periapsis = new THREE.Sprite(new THREE.SpriteMaterial({
			map: THREE.ImageUtils.loadTexture('images/periapsis.png'),
			transparent: true,
		}));
		ret.periapsis.scale.set(16,16,16);
		overlay.add(ret.periapsis);

		// Orbital speed at given position and eccentricity can be calculated by v = \sqrt(\mu (2 / r - 1 / a))
		// https://en.wikipedia.org/wiki/Orbital_speed
		ret.velocity = new THREE.Vector3(1, 0, 0).multiplyScalar(Math.sqrt(ret.parent.GM * (2 / ret.position.length() - 1 / semimajor_axis))).applyQuaternion(rotation);
		if(params && params.axialTilt && params.rotationPeriod){
			ret.quaternion = AxisAngleQuaternion(1, 0, 0, params.axialTilt);
			ret.angularVelocity = new THREE.Vector3(0, 0, 2 * Math.PI / params.rotationPeriod).applyQuaternion(ret.quaternion);
		}
		if(params && params.angularVelocity) ret.angularVelocity = params.angularVelocity;
		if(params && params.quaternion) ret.quaternion = params.quaternion;
		var orbitMesh = new THREE.Line(orbitGeometry, ret.orbitMaterial);
		ret.orbit = orbitMesh;
		scene.add(orbitMesh);
		ret.init();
		ret.update();
		return ret;
	}

	sun = new CelestialBody(null, new THREE.Vector3(), null, 0xffffff, GMsun);
	sun.radius = Rsun;
	sun.model = group;
	var mercury = AddPlanet(0.387098, 0.205630, 7.005 * rad_per_deg, 48.331 * rad_per_deg, 29.124 * rad_per_deg, 0x3f7f7f, 22032 / AU / AU / AU, sun, 'images/mercury.jpg', 2439.7, {soi: 2e5});
	var venus = AddPlanet(0.723332, 0.00677323, 3.39458 * rad_per_deg, 76.678 * rad_per_deg, 55.186 * rad_per_deg, 0x7f7f3f, 324859 / AU / AU / AU, sun, 'images/venus.jpg', 6051.8, {soi: 5e5});
	// Earth is at 1 AU (which is the AU's definition) and orbits around the ecliptic.
	var earth = AddPlanet(1, 0.0167086, 0, -11.26064 * rad_per_deg, 114.20783 * rad_per_deg, 0x3f7f3f, 398600 / AU / AU / AU, sun, 'images/land_ocean_ice_cloud_2048.jpg', 6534,
		{axialTilt: 23.4392811 * rad_per_deg,
		rotationPeriod: ((23 * 60 + 56) * 60 + 4.10),
		soi: 5e5});
	var sat = AddPlanet(10000 / AU, 0., 0, 0, 0, 0x3f7f7f, 100 / AU / AU / AU, earth, undefined, 0.1, {modelName: 'rocket.obj', controllable: true});
	sat.quaternion.multiply(AxisAngleQuaternion(1, 0, 0, Math.PI / 2)).multiply(AxisAngleQuaternion(0, 1, 0, Math.PI / 2));
	var moon = AddPlanet(384399 / AU, 0.0167086, 0, -11.26064 * rad_per_deg, 114.20783 * rad_per_deg, 0x5f5f5f, 4904.8695 / AU / AU / AU, earth, 'images/moon.png', 1737.1, {soi: 1e5});
	var mars = AddPlanet(1.523679, 0.0935, 1.850 * rad_per_deg, 49.562 * rad_per_deg, 286.537 * rad_per_deg, 0x7f3f3f, 42828 / AU / AU / AU, sun, 'images/mars.jpg', 3389.5, {soi: 3e5});
	var jupiter = AddPlanet(5.204267, 0.048775, 1.305 * rad_per_deg, 100.492 * rad_per_deg, 275.066 * rad_per_deg, 0x7f7f3f, 126686534 / AU / AU / AU, sun, 'images/jupiter.jpg', 69911, {soi: 10e6});
	select_obj = sat;
	center_select = true;
	camera.position.set(0.005, 0.003, 0.005);

	// Use icosahedron instead of sphere to make it look like uniform
	var asteroidGeometry = new THREE.IcosahedronGeometry( 1, 2 );
	// Modulate the vertices randomly to make it look like an asteroid. Simplex noise is desirable.
	for(var i = 0; i < asteroidGeometry.vertices.length; i++){
		asteroidGeometry.vertices[i].multiplyScalar(0.3 * (Math.random() - 0.5) + 1);
	}
	// Recalculate normal vectors according to updated vertices
	asteroidGeometry.computeFaceNormals();
	asteroidGeometry.computeVertexNormals();

	// Perlin noise is applied as detail texture.
	// It's asynchrnonous because it's shared by multiple asteroids.
	var asteroidTexture = THREE.ImageUtils.loadTexture('images/perlin.jpg');
	asteroidTexture.wrapS = THREE.RepeatWrapping;
	asteroidTexture.wrapT = THREE.RepeatWrapping;
	asteroidTexture.repeat.set(4, 4);
	var asteroidMaterial = new THREE.MeshLambertMaterial( {
		map: asteroidTexture,
		color: 0xffaf7f, shading: THREE.SmoothShading, overdraw: 0.5
	} );

	// Randomly generate asteroids
	for ( i = 0; i < 10; i ++ ) {

		var angle = Math.random() * Math.PI * 2;
		var position = new THREE.Vector3();
		position.x = 0.1 * (Math.random() - 0.5);
		position.y = 0.1 * (Math.random() - 0.5) + 1;
		position.z = 0.1 * (Math.random() - 0.5);
		position.applyQuaternion(AxisAngleQuaternion(0, 0, 1, angle));

		position.multiplyScalar(2.5);
		var asteroid = new CelestialBody(sun, position);
		asteroid.velocity = new THREE.Vector3((Math.random() - 0.5) * 0.3 - 1, (Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.3)
			.multiplyScalar(Math.sqrt(GMsun / position.length())).applyQuaternion(AxisAngleQuaternion(0, 0, 1, angle));

		asteroid.radius = Math.random() * 1 + 0.1;
		// We need nested Object3D for NLIPS
		asteroid.model = new THREE.Object3D();
		// The inner Mesh object has scale determined by radius
		var shape = new THREE.Mesh( asteroidGeometry, asteroidMaterial );
		asteroid.model.add(shape);
		var radiusInAu = viewScale * asteroid.radius / AU;
		shape.scale.set(radiusInAu, radiusInAu, radiusInAu);
		shape.up.set(0,0,1);
		scene.add( asteroid.model );

		var orbitMesh = new THREE.Line(orbitGeometry, asteroid.orbitMaterial);
		asteroid.orbit = orbitMesh;
		scene.add(orbitMesh);

		asteroid.init();
		asteroid.update();

	}

	renderer = new THREE.WebGLRenderer();
	renderer.setClearColor( 0x000000 );
	renderer.setSize( window.innerWidth, window.innerHeight );
	renderer.autoClear = false;

	cameraControls = new THREE.OrbitControls(camera, renderer.domElement);
	cameraControls.target.set( 0, 0, 0);
	cameraControls.noPan = true;
	cameraControls.maxDistance = 4000;
	cameraControls.minDistance = 1 / AU;
	cameraControls.update();

	container.appendChild( renderer.domElement );

	stats = new Stats();
	stats.domElement.style.position = 'absolute';
	stats.domElement.style.top = '0px';
	container.appendChild( stats.domElement );

	timescaleControl = new (function(){
		function clickForward(number){
			if(select_obj && 0 < select_obj.throttle){
				messageControl.setText('You cannot timewarp while accelerating');
				return;
			}
			for(var i = 0; i < forwards.length; i++)
				forwards[i].src = i <= number ? 'images/forward.png' : 'images/forward-inactive.png';
			text.innerHTML = 'Timescale: x' + series[number];
			timescale = series[number];
			timeIndex = number;
		}
		this.domElement = document.createElement('div');
		this.domElement.style.position = 'absolute';
		this.domElement.style.top = '50px';
		this.domElement.style.background = '#7f7f7f';
		this.domElement.style.zIndex = 10;
		var forwards = [];
		var series = [1, 5, 10, 100, 1e3, 1e4, 1e5, 1e6];
		var timeIndex = 0;
		for(var i = 0; i < series.length; i++){
			var forward = document.createElement('img');
			forward.src = i <= timeIndex ? 'images/forward.png' : 'images/forward-inactive.png';
			forward.style.width = '15px';
			forward.style.height = '20px';
			forward.number = i;
			forward.addEventListener('click', function(e){clickForward(this.number)});
			this.domElement.appendChild(forward);
			forwards.push(forward);
		}
		var text = document.createElement('div');
		text.innerHTML = 'Timescale: x1';
		this.domElement.appendChild(text);
		var date = document.createElement('div');
		this.domElement.appendChild(date);
		this.setDate = function(text){
			date.innerHTML = text;
		}
		this.increment = function(){
			if(select_obj && 0 < select_obj.throttle){
				messageControl.setText('You cannot timewarp while accelerating');
				return;
			}
			if(timeIndex + 1 < series.length)
				timeIndex++;
			clickForward(timeIndex);
		}
		this.decrement = function(){
			if(0 <= timeIndex - 1)
				timeIndex--;
			clickForward(timeIndex);
		}
	})();
	container.appendChild( timescaleControl.domElement );

	throttleControl = new (function(){
		function updatePosition(pos){
			if(1 < timescale && 0 < pos){
				messageControl.setText('You cannot accelerate while timewarping');
				return;
			}
			var rect = element.getBoundingClientRect();
			var handleRect = handle.getBoundingClientRect();
			var max = rect.height - handleRect.height;
			handle.style.top = (1 - pos) * max + 'px';
			if(select_obj.throttle === 0. && 0. < pos)
				select_obj.ignitionCount++;
			select_obj.throttle = pos;
			if(select_obj && select_obj.blastModel){
				select_obj.blastModel.visible = 0 < select_obj.throttle;
				var size = (select_obj.throttle + 0.1) / 1.1;
				select_obj.blastModel.scale.set(size, size, size);
			}
		}
		function movePosition(event){
			var rect = element.getBoundingClientRect();
			var handleRect = handle.getBoundingClientRect();
			var max = rect.height - handleRect.height;
			var pos = Math.min(max, Math.max(0, (event.clientY - rect.top) - handleRect.height / 2));
			updatePosition(1 - pos / max);
		}
		var guideHeight = 128;
		var guideWidth = 32;
		this.domElement = document.createElement('div');
		this.domElement.style.position = 'absolute';
		this.domElement.style.top = (window.innerHeight - guideHeight) + 'px';
		this.domElement.style.left = (windowHalfX - navballRadius - guideWidth) + 'px';
		this.domElement.style.background = '#7f7f7f';
		this.domElement.style.zIndex = 10;
		var element = this.domElement;
		var dragging = false;
		var im = document.createElement('img');
		im.src = 'images/throttle-back.png';
		im.onmousedown = function(event){
			dragging = true;
			movePosition(event);
		};
		im.onmousemove = function(event){
			if(dragging && event.buttons & 1)
				movePosition(event);
		};
		im.onmouseup = function(event){
			dragging = false;
		}
		im.draggable = true;
		im.ondragstart = function(event){
			event.preventDefault();
		};
		this.domElement.appendChild(im);
		var handle = document.createElement('img');
		handle.src = 'images/throttle-handle.png';
		handle.style.position = 'absolute';
		handle.style.top = (guideHeight - 16) + 'px';
		handle.style.left = '0px';
		handle.onmousemove = im.onmousemove;
		handle.onmousedown = im.onmousedown;
		handle.onmouseup = im.onmouseup;
		handle.ondragstart = im.ondragstart;
		this.domElement.appendChild(handle);
		this.increment = function(delta){
			if(select_obj)
				updatePosition(Math.min(1, select_obj.throttle + delta));
		}
		this.decrement = function(delta){
			if(select_obj)
				updatePosition(Math.max(0, select_obj.throttle - delta));
		}
		this.setThrottle = function(value){
			updatePosition(value);
		}
		window.addEventListener('resize', function(){
			element.style.top = (window.innerHeight - guideHeight) + 'px';
			element.style.left = (window.innerWidth / 2 - navballRadius - guideWidth) + 'px';
		});
	})();
	container.appendChild( throttleControl.domElement );

	var rotationControl = new (function(){
		function setSize(){
			rootElement.style.top = (window.innerHeight - 2 * navballRadius) + 'px';
			rootElement.style.left = (window.innerWidth / 2 - navballRadius) + 'px';
		}
		function addArrow(src, key, left, top){
			var button = document.createElement('img');
			button.src = src;
			button.width = buttonWidth;
			button.height = buttonHeight;
			button.style.position = 'absolute';
			button.style.top = top + 'px';
			button.style.left = left + 'px';
			button.onmousedown = function(event){
				window[key] = true;
			};
			button.onmouseup = function(event){
				window[key] = false;
				button.style.boxShadow = '';
			}
			button.ondragstart = function(event){
				event.preventDefault();
			};
			element.appendChild(button);
		}
		var buttonHeight = 32;
		var buttonWidth = 32;
		this.domElement = document.createElement('div');
		var rootElement = this.domElement;
		this.domElement.style.position = 'absolute';
		this.domElement.style.width = (navballRadius * 2) + 'px';
		this.domElement.style.height = (navballRadius * 2) + 'px';
		setSize();
		this.domElement.style.zIndex = 5;
		// Introduce internal 'div' because the outer 'div' cannot be
		// hidden since it need to receive mouseenter event.
		var element = document.createElement('div');
		element.style.width = '100%';
		element.style.height = '100%';
		element.style.display = 'none';
		this.domElement.appendChild(element);
		this.domElement.onmouseenter = function(event){
			element.style.display = 'block';
		};
		this.domElement.onmouseleave = function(event){
			element.style.display = 'none';
			up = down = left = right = false;
		};
		addArrow('images/rotate-up.png', 'up', navballRadius - buttonWidth / 2, 0);
		addArrow('images/rotate-down.png', 'down', navballRadius - buttonWidth / 2, 2 * navballRadius - buttonHeight);
		addArrow('images/rotate-left.png', 'left', 0, navballRadius - buttonHeight / 2);
		addArrow('images/rotate-right.png', 'right', 2 * navballRadius - buttonWidth, navballRadius - buttonHeight / 2);
		addArrow('images/rotate-cw.png', 'clockwise', 2 * navballRadius - buttonWidth, 0);
		addArrow('images/rotate-ccw.png', 'counterclockwise', 0, 0);
		window.addEventListener('resize', setSize);
	})();
	container.appendChild( rotationControl.domElement );

	speedControl = new (function(){
		function setSize(){
			element.style.top = (window.innerHeight - 2 * navballRadius - 32) + 'px';
			element.style.left = (window.innerWidth / 2 - element.getBoundingClientRect().width / 2) + 'px';
		}
		var buttonHeight = 32;
		var buttonWidth = 32;
		this.domElement = document.createElement('div');
		var element = this.domElement;
		element.style.position = 'absolute';
		setSize();
		element.style.zIndex = 7;
		element.style.background = 'rgba(0, 0, 0, 0.5)';
		window.addEventListener('resize', setSize);
		var title = document.createElement('div');
		title.innerHTML = 'Orbit';
		element.appendChild(title);
		var valueElement = document.createElement('div');
		element.appendChild(valueElement);
		this.setSpeed = function(){
			if(select_obj){
				var value = select_obj.velocity.length() * AU;
				if(value < 1)
					valueElement.innerHTML = (value * 1000).toFixed(4) + 'm/s';
				else
					valueElement.innerHTML = value.toFixed(4) + 'km/s';
			}
			else
				valueElement.innerHTML = '';
			element.style.left = (window.innerWidth / 2 - element.getBoundingClientRect().width / 2) + 'px';
		}
	})();
	container.appendChild( speedControl.domElement );

	orbitalElementControl = new (function(){
		var buttonHeight = 32;
		var buttonWidth = 32;
		this.domElement = document.createElement('div');
		var element = this.domElement;
		element.style.position = 'absolute';
		element.style.textAlign = 'left';
		element.style.top = 120 + 'px';
		element.style.left = 0 + 'px';
		element.style.zIndex = 7;
		var visible = false;
		var icon = document.createElement('img');
		icon.src = 'images/orbitIcon.png';
		element.appendChild(icon);

		var title = document.createElement('div');
		title.innerHTML = 'Orbital Elements';
		title.style.display = 'none';
		element.appendChild(title);

		var valueElement = document.createElement('div');
		element.appendChild(valueElement);
		valueElement.id = 'orbit';
		valueElement.style.display = 'none';

		// Register event handlers
		icon.ondragstart = function(event){
			event.preventDefault();
		};
		icon.onclick = function(event){
			visible = !visible;
			if(visible){
				valueElement.style.display = 'block';
				element.style.background = 'rgba(0, 0, 0, 0.5)';
			}
			else{
				valueElement.style.display = 'none';
				element.style.background = 'rgba(0, 0, 0, 0)';
			}
		};
		icon.onmouseenter = function(event){
			if(!visible)
				title.style.display = 'block';
		};
		icon.onmouseleave = function(event){
			if(!visible)
				title.style.display = 'none';
		};

		this.setText = function(text){
			valueElement.innerHTML = text;
		}
	})();
	container.appendChild( orbitalElementControl.domElement );

	statsControl = new (function(){
		function setSize(){
			element.style.left = (window.innerWidth - buttonWidth) + 'px';
			titleSetSize();
		}
		function titleSetSize(){
			title.style.left = '0px';
			var r = title.getBoundingClientRect();
			title.style.top = (buttonTop + buttonHeight - r.height) + 'px';
			title.style.left = (window.innerWidth - r.width - buttonWidth) + 'px';
		}
		var buttonTop = 120;
		var buttonHeight = 32;
		var buttonWidth = 32;
		this.domElement = document.createElement('div');
		var element = this.domElement;
		element.style.position = 'absolute';
		element.style.textAlign = 'left';
		element.style.top = buttonTop + 'px';
		element.style.left = 0 + 'px';
		element.style.zIndex = 7;
		var visible = false;
		var icon = document.createElement('img');
		icon.src = 'images/statsIcon.png';
		icon.style.width = buttonWidth + 'px';
		icon.style.height = buttonHeight + 'px';
		element.appendChild(icon);

		var title = document.createElement('div');
		title.innerHTML = 'Statistics';
		title.style.display = 'none';
		title.style.position = 'absolute';
		title.style.top = buttonTop + 'px';
		title.style.background = 'rgba(0, 0, 0, 0.5)';
		title.style.zIndex = 20;
		container.appendChild(title); // Appending to element's children didn't work well

		var valueElement = document.createElement('div');
		element.appendChild(valueElement);
		valueElement.style.display = 'none';
		valueElement.style.position = 'absolute';
		valueElement.style.background = 'rgba(0, 0, 0, 0.5)';
		valueElement.style.border = '3px ridge #7f3f3f';
		valueElement.style.padding = '3px';
		var valueElements = [];
		for(var i = 0; i < 3; i++){
			var titleElement = document.createElement('div');
			titleElement.innerHTML = ['Mission Time', 'Delta-V', 'Ignition&nbsp;Count'][i];
			titleElement.style.fontWeight = 'bold';
			titleElement.style.paddingRight = '1em';
			valueElement.appendChild(titleElement);
			var valueElementChild = document.createElement('div');
			valueElementChild.style.textAlign = 'right';
			valueElements.push(valueElementChild);
			valueElement.appendChild(valueElementChild);
		}

		setSize();

		// Register event handlers
		window.addEventListener('resize', setSize);
		icon.ondragstart = function(event){
			event.preventDefault();
		};
		icon.onclick = function(event){
			visible = !visible;
			if(visible){
				valueElement.style.display = 'block';
				element.style.background = 'rgba(0, 0, 0, 0.5)';
			}
			else{
				valueElement.style.display = 'none';
				element.style.background = 'rgba(0, 0, 0, 0)';
				settingsControl.domElement.style.top = element.getBoundingClientRect().bottom + 'px';
			}
		};
		icon.onmouseenter = function(event){
			if(!visible)
				title.style.display = 'block';
			titleSetSize();
		};
		icon.onmouseleave = function(event){
			if(!visible)
				title.style.display = 'none';
		};

		this.setText = function(text){
			if(!visible)
				return;
			if(!select_obj){
				valueElements[3].innerHTML = valueElements[2] = '';
				return;
			}
			var totalSeconds = (simTime.getTime() - startTime.getTime()) / 1e3;
			var seconds = Math.floor(totalSeconds) % 60;
			var minutes = Math.floor(totalSeconds / 60) % 60;
			var hours = Math.floor(totalSeconds / 60 / 60) % 24;
			var days = Math.floor(totalSeconds / 60 / 60 / 24);
			valueElements[0].innerHTML = days + 'd ' + zerofill(hours) + ':' + zerofill(minutes) + ':' + zerofill(seconds);
			var deltaVkm = select_obj.totalDeltaV * AU;
			var deltaV;
			if(deltaVkm < 10)
				deltaV = (deltaVkm * 1e3).toFixed(1) + 'm/s';
			else
				deltaV = deltaVkm.toFixed(4) + 'km/s';
			valueElements[1].innerHTML = deltaV;
			valueElements[2].innerHTML = select_obj.ignitionCount;
			valueElement.style.marginLeft = (buttonWidth - valueElement.getBoundingClientRect().width) + 'px';
			settingsControl.domElement.style.top = valueElement.getBoundingClientRect().bottom + 'px';
		}
	})();
	container.appendChild( statsControl.domElement );

	var scope = this;

	settingsControl = new (function(){
		function setSize(){
			element.style.left = (window.innerWidth - buttonWidth) + 'px';
			titleSetSize();
		}
		function titleSetSize(){
			var r = title.getBoundingClientRect();
			title.style.top = (icon.getBoundingClientRect().height - r.height) + 'px';
			title.style.left = (-r.width) + 'px';
		}
		var buttonTop = 154;
		var buttonHeight = 32;
		var buttonWidth = 32;
		this.domElement = document.createElement('div');
		var element = this.domElement;
		element.style.position = 'absolute';
		element.style.textAlign = 'left';
		element.style.top = buttonTop + 'px';
		element.style.left = 0 + 'px';
		element.style.zIndex = 7;
		var visible = false;
		var icon = document.createElement('img');
		icon.src = 'images/settingsIcon.png';
		icon.style.width = buttonWidth + 'px';
		icon.style.height = buttonHeight + 'px';
		element.appendChild(icon);

		var title = document.createElement('div');
		title.innerHTML = 'Settings';
		title.style.display = 'none';
		title.style.position = 'absolute';
		title.style.background = 'rgba(0, 0, 0, 0.5)';
		title.style.zIndex = 20;
		element.appendChild(title);

		var valueElement = document.createElement('div');
		element.appendChild(valueElement);
		valueElement.style.display = 'none';
		valueElement.style.position = 'absolute';
		valueElement.style.background = 'rgba(0, 0, 0, 0.5)';
		valueElement.style.border = '3px ridge #7f3f3f';
		valueElement.style.padding = '3px';
		// The settings variables are function local variables, so we can't just pass this pointer
		// and parameter name and do something like `this[name] = !this[name]`.
		var toggleFuncs = [function(){grid_enable = !grid_enable}, function(){sync_rotate = !sync_rotate}, function(){nlips_enable = !nlips_enable}];
		var checkElements = [];
		for(var i = 0; i < 3; i++){
			var lineElement = document.createElement('div');
			var checkbox = document.createElement('input');
			checkbox.type = 'checkbox';
			checkbox.onclick = toggleFuncs[i];
			lineElement.appendChild(checkbox);
			checkElements.push(checkbox);
			lineElement.insertAdjacentHTML('beforeend', ['Show&nbsp;grid&nbsp;(G)', 'Chase&nbsp;camera&nbsp;(H)', 'Nonlinear&nbsp;scale&nbsp;(N)'][i]);
			lineElement.style.fontWeight = 'bold';
			lineElement.style.paddingRight = '1em';
			lineElement.style.whiteSpace = 'nowrap';
			valueElement.appendChild(lineElement);
		}

		setSize();

		// Register event handlers
		window.addEventListener('resize', setSize);
		icon.ondragstart = function(event){
			event.preventDefault();
		};
		icon.onclick = function(event){
			visible = !visible;
			if(visible){
				valueElement.style.display = 'block';
				element.style.background = 'rgba(0, 0, 0, 0.5)';
			}
			else{
				valueElement.style.display = 'none';
				element.style.background = 'rgba(0, 0, 0, 0)';
			}
		};
		icon.onmouseenter = function(event){
			if(!visible)
				title.style.display = 'block';
			titleSetSize();
		};
		icon.onmouseleave = function(event){
			if(!visible)
				title.style.display = 'none';
		};

		this.setText = function(text){
			if(!visible)
				return;
			checkElements[0].checked = grid_enable;
			checkElements[1].checked = sync_rotate;
			checkElements[2].checked = nlips_enable;
			valueElement.style.marginLeft = (buttonWidth - valueElement.getBoundingClientRect().width) + 'px';
		}
	})();
	container.appendChild( settingsControl.domElement );

	altitudeControl = new (function(){
		var buttonHeight = 32;
		var buttonWidth = 32;
		this.domElement = document.createElement('div');
		var element = this.domElement;
		element.style.position = 'absolute';
		element.style.top = '2em';
		element.style.left = '50%';
		element.style.background = 'rgba(0,0,0,0.5)';
		element.style.zIndex = 8;
		var visible = false;

		// Register event handlers
		element.ondragstart = function(event){
			event.preventDefault();
		};

		this.setText = function(value){
			var text;
			if(value < 1e5)
				text = value.toFixed(4) + 'km';
			else if(value < 1e8)
				text = (value / 1000).toFixed(4) + 'Mm';
			else
				text = (value / AU).toFixed(4) + 'AU';
			element.innerHTML = text;
			element.style.marginLeft = -element.getBoundingClientRect().width / 2 + 'px';
		};
	})();
	container.appendChild( altitudeControl.domElement );

	messageControl = new (function(){
		this.domElement = document.createElement('div');
		var element = this.domElement;
		element.style.position = 'absolute';
		element.style.top = '25%';
		element.style.left = '50%';
		element.style.fontSize = '20px';
		element.style.fontWeight = 'bold';
		element.style.textShadow = '0px 0px 5px rgba(0,0,0,1)';
		element.style.zIndex = 20;
		var showTime = 0;

		// Register event handlers
		element.ondragstart = function(event){
			event.preventDefault();
		};
		// Disable text selection
		element.onselectstart = function(){ return false; }

		this.setText = function(text){
			element.innerHTML = text;
			element.style.display = 'block';
			element.style.opacity = '1';
			element.style.marginTop = -element.getBoundingClientRect().height / 2 + 'px';
			element.style.marginLeft = -element.getBoundingClientRect().width / 2 + 'px';
			showTime = 5; // Seconds to show should depend on text length!
		};

		this.timeStep = function(deltaTime){
			if(showTime < deltaTime){
				element.style.display = 'none';
				showTime = 0;
				return;
			}
			showTime -= deltaTime;
			if(showTime < 2);
				element.style.opacity = (showTime / 2).toString();
		}
	})
	container.appendChild( messageControl.domElement );

	window.addEventListener( 'resize', onWindowResize, false );
	window.addEventListener( 'keydown', onKeyDown, false );
	window.addEventListener( 'keyup', onKeyUp, false );

	// Start the clock after the initialization is finished, otherwise
	// the very first frame of simulation can be long.
	simTime = new Date();
	realTime = simTime;
	startTime = simTime;
}

function onWindowResize() {

	windowHalfX = window.innerWidth / 2;
	windowHalfY = window.innerHeight / 2;

	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();

	renderer.setSize( window.innerWidth, window.innerHeight );

}

function animate() {

	requestAnimationFrame( animate );

	render();
	stats.update();

}

// Fills leading zero if the value is less than 10, making the returned string always two characters long.
// Note that values not less than 100 or negative values are not guaranteed to be two characters wide.
// This function is for date time formatting purpose only.
function zerofill(v){
	if(v < 10)
		return "0" + v;
	else
		return v;
}

function render() {
	var now = new Date();
	var realDeltaTimeMilliSec = now.getTime() - realTime.getTime();
	var time = new Date(simTime.getTime() + realDeltaTimeMilliSec * timescale);
	var deltaTime = (time.getTime() - simTime.getTime()) * 1e-3;
	realTime = now;
	simTime = time;
	timescaleControl.setDate(time.getFullYear() + '/' + zerofill(time.getMonth() + 1) + '/' + zerofill(time.getDate())
		+ ' ' + zerofill(time.getHours()) + ':' + zerofill(time.getMinutes()) + ':' + zerofill(time.getSeconds()));
	speedControl.setSpeed();
	statsControl.setText();
	settingsControl.setText();
	messageControl.timeStep(realDeltaTimeMilliSec * 1e-3);

	camera.near = Math.min(1, cameraControls.target.distanceTo(camera.position) / 10);
	camera.updateProjectionMatrix();

	var acceleration = 5e-10;
	var div = 100; // We should pick subdivide simulation step count by angular speed!
	function simulateBody(parent){
		var children = parent.children;
		for(var i = 0; i < children.length;){
			var a = children[i];
			var sl = a.position.lengthSq();
			if(sl !== 0){
				var angleAcceleration = 1e-0;
				var accel = a.position.clone().negate().normalize().multiplyScalar(deltaTime / div * a.parent.GM / sl);
				if(select_obj === a && select_obj.controllable && timescale <= 1){
					if(up) select_obj.angularVelocity.add(new THREE.Vector3(0, 0, 1).applyQuaternion(select_obj.quaternion).multiplyScalar(angleAcceleration * deltaTime / div));
					if(down) select_obj.angularVelocity.add(new THREE.Vector3(0, 0, -1).applyQuaternion(select_obj.quaternion).multiplyScalar(angleAcceleration * deltaTime / div));
					if(left) select_obj.angularVelocity.add(new THREE.Vector3(0, 1, 0).applyQuaternion(select_obj.quaternion).multiplyScalar(angleAcceleration * deltaTime / div));
					if(right) select_obj.angularVelocity.add(new THREE.Vector3(0, -1, 0).applyQuaternion(select_obj.quaternion).multiplyScalar(angleAcceleration * deltaTime / div));
					if(counterclockwise) select_obj.angularVelocity.add(new THREE.Vector3(1, 0, 0).applyQuaternion(select_obj.quaternion).multiplyScalar(angleAcceleration * deltaTime / div));
					if(clockwise) select_obj.angularVelocity.add(new THREE.Vector3(-1, 0, 0).applyQuaternion(select_obj.quaternion).multiplyScalar(angleAcceleration * deltaTime / div));
					if(!up && !down && !left && !right && !counterclockwise && !clockwise){
						// Immediately stop micro-rotation if the body is controlled.
						// This is done to make it still in larger timescale, since micro-rotation cannot be canceled
						// by product of angularVelocity and quaternion which underflows by square.
						// Think that the vehicle has a momentum wheels that cancels micro-rotation continuously working.
						if(1e-6 < select_obj.angularVelocity.lengthSq())
							select_obj.angularVelocity.add(select_obj.angularVelocity.clone().normalize().multiplyScalar(-angleAcceleration * deltaTime / div));
						else
							select_obj.angularVelocity.set(0, 0, 0);
					}
					if(0 < select_obj.throttle){
						var deltaV = acceleration * select_obj.throttle * deltaTime / div;
						select_obj.velocity.add(new THREE.Vector3(1, 0, 0).applyQuaternion(select_obj.quaternion).multiplyScalar(deltaV));
						select_obj.totalDeltaV += deltaV;
					}
				}
				var dvelo = accel.clone().multiplyScalar(0.5);
				var vec0 = a.position.clone().add(a.velocity.clone().multiplyScalar(deltaTime / div / 2.));
				var accel1 = vec0.clone().negate().normalize().multiplyScalar(deltaTime / div * a.parent.GM / vec0.lengthSq());
				var velo1 = a.velocity.clone().add(dvelo);

				a.velocity.add(accel1);
				a.position.add(velo1.multiplyScalar(deltaTime / div));
				if(0 < a.angularVelocity.lengthSq()){
					var axis = a.angularVelocity.clone().normalize();
					// We have to multiply in this order!
					a.quaternion.multiplyQuaternions(AxisAngleQuaternion(axis.x, axis.y, axis.z, a.angularVelocity.length() * deltaTime / div), a.quaternion);
				}
			}
			// Only controllable objects can change orbiting body
			if(a.controllable){
				// Check if we are leaving sphere of influence of current parent.
				if(a.parent.parent && a.parent.soi && a.parent.soi * 1.01 < a.position.length()){
					a.position.add(parent.position);
					a.velocity.add(parent.velocity);
					var j = children.indexOf(a);
					if(0 <= j)
						children.splice(j, 1);
					a.parent = parent.parent;
					a.parent.children.push(a);
					continue; // Continue but not increment i
				}
				var skip = false;
				// Check if we are entering sphere of influence of another sibling.
				for(var j = 0; j < children.length; j++){
					var aj = children[j];
					if(aj === a)
						continue;
					if(!aj.soi)
						continue;
					if(aj.position.distanceTo(a.position) < aj.soi * .99){
						a.position.sub(aj.position);
						a.velocity.sub(aj.velocity);
						var k = children.indexOf(a);
						if(0 <= k)
							children.splice(k, 1);
						a.parent = aj;
						aj.children.push(a);
						skip = true;
						break;
					}
				}
				if(skip)
					continue; // Continue but not increment i
			}
			simulateBody(a);
			i++;
		}
	}

	for(var d = 0; d < div; d++){
		// Allow trying to increase throttle when timewarping in order to show the message
		if(accelerate) throttleControl.increment(deltaTime / div);
		if(decelerate) throttleControl.decrement(deltaTime / div);

		simulateBody(sun);
	}
	sun.update();

	var irotate = AxisAngleQuaternion(-1, 0, 0, Math.PI / 2);
	// offset sun position
	light.position.copy(sun.model.position);

	grids.visible = grid_enable;

//				camera.up.copy(new THREE.Vector3(0,0,1)); // This did't work with OrbitControls
	cameraControls.update();

	var oldPosition = camera.position.clone();
	var oldQuaternion = camera.quaternion.clone();
	if(sync_rotate && select_obj){
		camera.quaternion.copy(
			select_obj.quaternion.clone()
			.multiply(AxisAngleQuaternion(0, 1, 0, -1*Math.PI / 2)));
		camera.position.copy(new THREE.Vector3(0, 0.2, 1).normalize().multiplyScalar(camera.position.length()).applyQuaternion(camera.quaternion));
	}
	var position = camera.position.clone();
	camera.position.set(0,0,0);
	renderer.render( background, camera);
	camera.position.copy(position);
	renderer.render( scene, camera );

	if(navballMesh && select_obj && select_obj.controllable){
		// First, calculate the quaternion for rotating the system so that
		// X axis points north, Y axis points east and Z axis points zenith.
		var north = new THREE.Vector3(0, 0, 1).applyQuaternion(select_obj.parent.quaternion);
		var tangent = north.cross(select_obj.position).normalize();
		var qball = new THREE.Quaternion();
		var mat = new THREE.Matrix4();
		var normal = select_obj.position.clone().normalize().negate();
		mat.makeBasis(tangent.clone().cross(normal), tangent, normal);
		qball.setFromRotationMatrix (mat);

		navballMesh.quaternion.copy(
			AxisAngleQuaternion(0, 1, 0, -1*Math.PI / 2)
			.multiply(AxisAngleQuaternion(0, 0, 1, Math.PI))
			.multiply(select_obj.quaternion.clone().conjugate())
			.multiply(qball)
			.multiply(AxisAngleQuaternion(1, 0, 0, Math.PI / 2))
			);
		navballMesh.position.y = -window.innerHeight / 2 + navballRadius;
		var grade;
		var factor;
		if(new THREE.Vector3(1, 0, 0).applyQuaternion(select_obj.quaternion).dot(select_obj.velocity) < 0){
			grade = retrograde;
			prograde.visible = false;
			factor = -1.;
		}
		else{
			grade = prograde;
			retrograde.visible = false;
			factor = 1.;
		}
		grade.visible = true;
		grade.position.y = -window.innerHeight / 2 + navballRadius + factor * new THREE.Vector3(0, 1, 0).applyQuaternion(select_obj.quaternion).dot(select_obj.velocity) / select_obj.velocity.length() * navballRadius;
		grade.position.x = factor * new THREE.Vector3(0, 0, 1).applyQuaternion(select_obj.quaternion).dot(select_obj.velocity) / select_obj.velocity.length() * navballRadius;
		camera.position.set(0,0,0);
		camera.quaternion.set(1,0,0,0);
		renderer.render( overlay, overlayCamera);
	}

	// Restore the original state because cameraControls expect these variables unchanged
	camera.quaternion.copy(oldQuaternion);
	camera.position.copy(oldPosition);

	if(select_obj && select_obj.parent){
		altitudeControl.setText(select_obj.position.length() * AU - select_obj.parent.radius);
	}
	else
		altitudeControl.setText(0);
}

function onKeyDown( event ) {
	var char = String.fromCharCode(event.which || event.keyCode).toLowerCase();

	switch ( char ) {

		case 'i':
			if(select_obj === null)
				select_obj = sun.children[0];
			else{
				// Some objects do not have an orbit
				if(select_obj.orbit)
					select_obj.orbit.material = select_obj.orbitMaterial;
				var objs = select_obj.children;
				if(0 < objs.length){
					select_obj = objs[0];
				}
				else{
					var selected = false;
					var prev = select_obj;
					for(var parent = select_obj.parent; parent; parent = parent.parent){
						objs = parent.children;
						for(var i = 0; i < objs.length; i++){
							var o = objs[i];
							if(o === prev && i + 1 < objs.length){
								select_obj = objs[i+1];
								selected = true;
								break;
							}
						}
						if(selected)
							break;
						prev = parent;
					}
					if(!parent)
						select_obj = sun;
				}
			}
			if(select_obj.orbit)
				select_obj.orbit.material = selectedOrbitMaterial;
			break;

		case 'c':
			center_select = !center_select;
			break;

		case 'n': // toggle NLIPS
			nlips_enable = !nlips_enable;
			break;

		case 'g':
			grid_enable = !grid_enable;
			break;

		case 'h':
			sync_rotate = !sync_rotate;
			break;
	}

	if(select_obj && select_obj.controllable) switch( char ){
		case 'w': // prograde
			down = true;
//						prograde = true;
			break;
		case 's': // retrograde
			up = true;
//						retrograde = true;
			break;
		case 'q': // normal
			counterclockwise = true;
//						normal = true;
			break;
		case 'e': // normal negative
			clockwise = true;
//						antinormal = true;
			break;
		case 'a': // orbit plane normal
			left = true;
//						incline = true;
			break;
		case 'd': // orbit plane normal negative
			right = true;
//						antiincline = true;
			break;
		case 'z':
			throttleControl.setThrottle(1);
			break;
		case 'x':
			throttleControl.setThrottle(0);
			break;
	}

	// Annoying browser incompatibilities
	var code = event.which || event.keyCode;
	// Also support numpad plus and minus
	if(code === 107 || code === 187 && event.shiftKey)
		timescaleControl.increment();
	if(code === 109 || code === 189)
		timescaleControl.decrement();
	if(code === 16)
		accelerate = true;
	if(code === 17)
		decelerate = true;
}

function onKeyUp( event ) {
	switch ( String.fromCharCode(event.which || event.keyCode).toLowerCase() ) {
		case 'w': // prograde
			down = false;
//						prograde = false;
			break;
		case 's':
			up = false;
//						retrograde = false;
			break;
		case 'q': // prograde
			counterclockwise = false;
//						normal = false;
			break;
		case 'e':
			clockwise = false;
//						antinormal = false;
			break;
		case 'a': // orbit plane normal
			left = false;
//						incline = false;
			break;
		case 'd': // orbit plane normal negative
			right = false;
//						antiincline = false;
			break;
	}
	// Annoying browser incompatibilities
	var code = event.which || event.keyCode;
	if(code === 16)
		accelerate = false;
	if(code === 17)
		decelerate = false;
}

init();
animate();
})()
